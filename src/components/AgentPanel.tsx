/**
 * One Herdsman agent in full (design/pi-native-chat/DESIGN.md §4.8): its task, what it is doing, and
 * the three ways to steer it — a message, an interrupt, or an answer to its question — plus Close and,
 * once it is done, its answer and Continue. The panel is a leaf: every command leaves as the
 * extension's `/hm …` prompt (§4.8, Phase 15) through `onCommand`, so nothing here knows piRpc or the
 * store. The owner docks it in the file panel's slot and gives the focus back to the Agents chip when
 * it closes; the resizer and the grip seam are the owner's too, drawn inside the panel's box through
 * `panelStart`. Below 980px it is a sheet instead, and `back` is the way out it shares a phone with the
 * roster.
 *
 * The activity feed is throttled to one swap a second and is never announced: it is a log, and its
 * churn is not news (RD §8). The head badge's words are, which is why they are the roster's.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Circle, CircleCheck, CircleDot, CircleX, Maximize2, MessageCircle, X } from "lucide-react";

import "./AgentPanel.css";

import type { HerdsmanAgent, HerdsmanAgentState } from "../../shared/protocol.ts";
import { herdsmanElapsedMs } from "../lib/herdsman.ts";
import { useT } from "../lib/i18n.ts";
import { formatElapsed } from "../lib/omoTasks.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Markdown } from "./Markdown.tsx";

/** The ways to message an agent, in the order the segmented control draws them. */
const MODES = ["steer", "interrupt", "reply"] as const;
type Mode = (typeof MODES)[number];

/** The roster's glyphs, so an agent reads the same in the panel as in the tree. */
const STATE_ICON: Record<HerdsmanAgentState, typeof Circle> = {
  starting: CircleDot,
  running: CircleDot,
  asks: MessageCircle,
  finished: CircleCheck,
  failed: CircleX,
  stale: Circle,
  closed: Circle,
};

/** The states whose run is over: the panel keeps the answer and drops the message box. */
const ENDED: readonly HerdsmanAgentState[] = ["finished", "failed"];

/** Past this length a task keeps its 3-line clamp and takes the fold. */
// shortcut: "long" is a character count, measure the painted lines if the clamp ever disagrees
const TASK_FOLD_CHARS = 140;

/** The feed swaps at most once a second; lines that arrive meanwhile wait for the next swap. */
const FEED_MS = 1000;

interface Props {
  agent: HerdsmanAgent;
  /** the extension's commands, from `PiNativeHerdsman.capabilities`: steer, interrupt, reply, close, continue */
  capabilities: readonly string[];
  /** one `/hm …` extension command, sent to Pi as a prompt; a failure leaves the draft alone */
  onCommand: (command: string) => Promise<unknown> | void;
  onClose: () => void;
  /** the expand glyph is drawn only when the owner can take the panel wider than it is */
  onExpand?: () => void;
  /** the seam the owner drags (FilePanelResizer): first in the box, as in the docked viewer */
  panelStart?: ReactNode;
  /** the sheet's way back to the list it came from; drawn leading, before the name */
  back?: { label: string; run: () => void };
}

/** A work row as the extension sent it: the leading verb, then the mono object. */
function splitLine(line: string): [string, string] {
  const at = line.indexOf(" ");
  return at < 0 ? [line, ""] : [line.slice(0, at), line.slice(at + 1)];
}

export function AgentPanel({ agent, capabilities, onCommand, onClose, onExpand, panelStart, back }: Props) {
  const t = useT();
  const caps = capabilities.join(" ");
  const modes = MODES.filter((mode) => capabilities.includes(mode));
  const question = agent.question;
  const ended = ENDED.includes(agent.state);
  const canReply = question !== undefined && modes.includes("reply");

  const [mode, setMode] = useState<Mode>(() => (canReply ? "reply" : modes[0] ?? "steer"));
  const [text, setText] = useState("");
  /** Interrupt's first press only arms the button: the run ends on the second */
  const [armed, setArmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const titleId = useId();
  const activityId = useId();

  // the lines as drawn: the live ones arrive at most once a second, newest kept for the next swap
  const live = useMemo(() => (agent.state === "running" ? agent.activity ?? [] : []), [agent.state, agent.activity]);
  const [feed, setFeed] = useState<readonly string[]>(live);
  const newest = useRef<readonly string[]>(live);
  newest.current = live;
  const swap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLDivElement>(null);
  /** the reader scrolled up: new lines no longer move the box */
  const following = useRef(true);

  useEffect(() => {
    if (swap.current !== null) return;
    swap.current = setTimeout(() => {
      swap.current = null;
      setFeed(newest.current);
    }, FEED_MS);
  }, [live]);
  useEffect(() => () => { if (swap.current !== null) clearTimeout(swap.current); }, []);

  // a question that arrives while the panel is open takes the mode, as opening it fresh would; a
  // different agent starts from its own feed rather than showing the last one's lines for a second
  const startedWith = useRef(agent.label);
  useEffect(() => {
    setMode(canReply ? "reply" : modes[0] ?? "steer");
    setArmed(false);
    if (startedWith.current !== agent.label) {
      startedWith.current = agent.label;
      setFeed(newest.current);
    }
  }, [agent.label, canReply, caps]);

  // the box follows new lines until the reader scrolls up
  useEffect(() => {
    const element = box.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
  }, [feed]);

  const pick = (next: Mode): void => {
    if (next === "reply" && question === undefined) return;
    setMode(next);
    setArmed(false);
  };

  const send = async (): Promise<void> => {
    if (sending || text.trim() === "" || modes.length === 0) return;
    if (mode === "interrupt" && !armed) {
      setArmed(true);
      return;
    }
    if (mode === "reply" && question === undefined) return;
    setSending(true);
    try {
      await onCommand(`/hm ${mode} ${agent.label} ${text}`);
      setText("");
      setArmed(false);
    } catch {
      // the owner's status line says why (DS §3.3); the draft stays, so nothing typed is lost
    } finally {
      setSending(false);
    }
  };

  const closeAgent = async (): Promise<void> => {
    await onCommand(`/hm close ${agent.label}`);
    onClose();
  };

  /** a command the owner reports the failure of (DS §3.3): the panel itself has nothing to add */
  const run = (command: string): void => { void Promise.resolve(onCommand(command)).catch(() => {}); };

  const elapsed = herdsmanElapsedMs(agent, Date.now());
  const owner = [
    t("This session"),
    elapsed === null ? null : t("started {elapsed} ago", { elapsed: formatElapsed(elapsed) }),
    agent.toolCalls === undefined ? null : t("{count} tool calls", { count: agent.toolCalls }),
    agent.tokens === undefined ? null : t("{tokens}k tokens", { tokens: Math.round(agent.tokens / 1000) }),
  ].filter((part): part is string => part !== null).join(" · ");

  const stateWords: Record<HerdsmanAgentState, string> = {
    starting: t("Starting"),
    running: t("Running"),
    asks: t("Asks you"),
    finished: t("Finished"),
    failed: t("Failed"),
    stale: t("Not responding"),
    closed: t("Closed"),
  };
  const modeWords: Record<Mode, string> = { steer: t("Steer"), interrupt: t("Interrupt"), reply: t("Reply") };
  const hint = mode === "steer" ? t("Delivered after its current step.") : mode === "interrupt" ? t("Stops what it is doing now.") : "";
  const StateIcon = STATE_ICON[agent.state];

  return (
    <aside className="agent-panel" aria-labelledby={titleId}>
      {panelStart}
      <header className="agent-panel-header">
        {back !== undefined && <button type="button" className="btn btn-ghost agent-panel-back" onClick={() => back.run()}>{back.label}</button>}
        <h2 className="agent-panel-title" id={titleId}>
          <span className="agent-panel-name">{agent.label}</span> · <span className="pill">{agent.definition}</span>
        </h2>
        <span className={`pill agent-panel-state is-${agent.state}`}>
          <StateIcon className="agent-panel-state-icon" aria-hidden="true" />
          {stateWords[agent.state]}
        </span>
        {onExpand !== undefined && <button type="button" className="icon-button" aria-label={t("Expand")} title={t("Expand")} onClick={onExpand}><Maximize2 aria-hidden="true" /></button>}
        <button type="button" className="icon-button" aria-label={t("Close panel")} title={t("Close panel")} onClick={onClose}><X aria-hidden="true" /></button>
      </header>

      {agent.task !== undefined && agent.task.length > 0 && <div className="agent-panel-task">
        <p className="agent-panel-label">{t("Task")}</p>
        <p className="agent-panel-task-text" data-open={taskOpen || undefined}>{agent.task}</p>
        {agent.task.length > TASK_FOLD_CHARS && <button type="button" className="agent-panel-fold" aria-expanded={taskOpen} onClick={() => setTaskOpen((open) => !open)}>{t("Show full task")}</button>}
      </div>}

      <p className="agent-panel-owner">{owner}</p>

      {feed.length > 0 && <section className="agent-panel-activity-section" aria-labelledby={activityId}>
        <h3 className="agent-panel-label" id={activityId}>{t("Activity")}</h3>
        <div ref={box} className="agent-panel-activity" tabIndex={0} onScroll={() => {
          const element = box.current;
          if (element === null) return;
          following.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 4;
        }}>
          {feed.map((line, index) => {
            const [verb, object] = splitLine(line);
            return <p key={`${index}:${line}`} className="agent-panel-line">
              <span className="agent-panel-verb">{verb}</span>
              {object !== "" && <> <span className="agent-panel-object">{object}</span></>}
            </p>;
          })}
        </div>
      </section>}

      {ended
        ? <div className="agent-panel-message agent-panel-ended">
          <p className="agent-panel-ended-note">{t("This agent has finished.")}</p>
          {agent.answer !== undefined && agent.answer.length > 0 && <div className="agent-panel-answer"><Markdown>{agent.answer}</Markdown></div>}
          {agent.resumable === true && capabilities.includes("continue") && <button type="button" className="btn agent-panel-continue" onClick={() => run(`/hm continue ${agent.label}`)}>{t("Continue")}</button>}
        </div>
        : modes.length > 0 && <div className="agent-panel-message">
          <div className="agent-panel-message-head">
            <span className="agent-panel-label">{t("Message agent")}</span>
            <div className="segmented agent-panel-modes" role="group" aria-label={t("Message agent")}>
              {modes.map((option) => {
                const disabled = option === "reply" && question === undefined;
                return <button key={option} type="button" aria-pressed={mode === option} aria-disabled={disabled || undefined}
                  title={disabled ? t("It isn't asking anything.") : undefined} onClick={() => pick(option)}>{modeWords[option]}</button>;
              })}
            </div>
          </div>

          {mode === "reply" && question !== undefined && <div className="agent-panel-question">
            <p className="agent-panel-question-text">{question.text}</p>
            {question.files.length > 0 && <p className="agent-panel-files">{question.files.map((file) => <code key={file} className="agent-panel-file">{file}</code>)}</p>}
          </div>}

          <textarea className="input agent-panel-field" rows={2} aria-label={t("Message agent")} value={text}
            onChange={(event) => { setText(event.target.value); setArmed(false); }} />

          <div className="agent-panel-send">
            <span className="agent-panel-hint">{hint}</span>
            <button type="button" className={mode === "interrupt" && armed ? "btn btn-danger" : "btn btn-primary"}
              disabled={text.trim() === "" || sending} onClick={() => void send()}>
              {mode === "interrupt" && armed ? t("Interrupt now?") : t("Send")}
            </button>
          </div>
        </div>}

      {capabilities.includes("close") && <div className="agent-panel-foot">
        <button type="button" className="btn btn-ghost" onClick={() => setClosing(true)}>{t("Close agent")}</button>
      </div>}

      {closing && <ConfirmDialog title={t("Close {label}?", { label: agent.label })} body={t("It stops now and can't be resumed.")}
        confirmLabel={t("Close agent")} onConfirm={closeAgent} onClose={() => setClosing(false)} />}
    </aside>
  );
}
