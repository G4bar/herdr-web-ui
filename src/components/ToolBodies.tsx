/**
 * What an opened tool card draws of a Pi call body (DS §4.6). A call on a native pane runs while the
 * transcript still holds no result of it: its last output lines arrive as `PiNativeState.toolTails`,
 * keyed by the id the call has in the transcript, and the card draws them under a Stop until they
 * stop arriving.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AskedAnswer } from "../lib/askQuestions.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { CHAT_HIGHLIGHT_LIMIT, languageForPath } from "../lib/highlight.ts";
import { useT } from "../lib/i18n.ts";
import { HighlightedCode } from "./HighlightedCode.tsx";

/** What an opened card reads beyond its own part; ChatView provides it, a chat with no native Pi holds none. */
export interface PiToolCard {
  /** a running call's last output lines, by tool-call id; null when no Pi is driven over RPC here */
  tails: Record<string, string[]> | null;
  /** aborts the running turn: the card's Stop. Null where the chat has no Pi to command */
  abort: (() => void) | null;
}

export const NO_PI_TOOL_CARD: PiToolCard = { tails: null, abort: null };

export const PiToolCardContext = createContext<PiToolCard>(NO_PI_TOOL_CARD);

export function usePiToolCard(): PiToolCard {
  return useContext(PiToolCardContext);
}

/**
 * A bash call's output as its card shows it: pi ends a failed command's text with its own exit
 * line, which the card draws apart in the error tint, and a command that finished clean has none.
 * A command whose output pi itself cut ends with the lines it kept and the file holding all of it,
 * which the card draws as the way to that file (`cut`), not as output.
 */
export function bashCard(output: string): { text: string; exit: number | null; cut: string | null } {
  const exited = /\n*Command exited with code (\d+)\s*$/.exec(output);
  const code = exited === null ? null : Number(exited[1]);
  const whole = exited === null ? output : output.slice(0, exited.index).replace(/\n+$/, "");
  const cut = /\n*\[Showing (?:lines|last)[^\]]*Full output: ([^\]\n]+)\]\s*$/.exec(whole);
  if (cut === null) return { text: whole, exit: code !== null && code > 0 ? code : null, cut: null };
  return {
    text: whole.slice(0, cut.index).replace(/\n… trimmed$/, "").replace(/\n+$/, ""),
    exit: code !== null && code > 0 ? code : null,
    cut: cut[1]!.trim(),
  };
}

/**
 * The lines of a call still running, as they arrive. The box follows the newest line until the
 * reader scrolls away from it, and stays where they left it after that.
 */
export function ToolTail({ lines }: { lines: readonly string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    const box = ref.current;
    if (box !== null && following) box.scrollTop = box.scrollHeight;
  }, [lines, following]);
  return <pre className="chat-tool-io chat-tool-tail" ref={ref} onScroll={(event) => {
    const box = event.currentTarget;
    setFollowing(box.scrollHeight - box.scrollTop - box.clientHeight < 8);
  }}>{lines.join("\n")}</pre>;
}

/** The lines a file body shows before it folds: the head of what a read gave back, or of what a write put down (DS §4.6). */
export const READ_HEAD_LINES = 10;
export const WRITE_HEAD_LINES = 20;

/** A file a pi call touched, and what its card draws of it. */
export interface FileBody {
  path: string;
  /** the lines a ranged read covered; null when the call read a whole file, or wrote one */
  range: string | null;
  code: string;
  head: number;
}

function inputRecord(input: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(input);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** The lines a ranged read covers, as the card's dim line: offset is 1-indexed, limit counts from it. */
function readRange(args: Record<string, unknown>): string | null {
  const limit = typeof args["limit"] === "number" && args["limit"] > 0 ? Math.floor(args["limit"]) : null;
  const offset = typeof args["offset"] === "number" && args["offset"] > 0 ? Math.floor(args["offset"]) : limit === null ? null : 1;
  if (offset === null) return null;
  return `${offset}–${limit === null ? "" : offset + limit - 1}`;
}

/**
 * A pi `read` or `write` call's body, or null for any other call (another agent's Read keeps the
 * plain input view). A read draws the file it gave back; a write draws what it was told to put
 * there. A picture pi read into the result draws its thumbnail alone: the note the call recorded
 * ("Read image file …") says nothing the card does not. A call that failed keeps its own view: the
 * file it never read or wrote is not its body, and the agent's message is.
 */
export function toolFileBody(part: { name: string; input: string; output: string; images?: boolean; error?: boolean }): FileBody | null {
  if (part.name !== "read" && part.name !== "write") return null;
  if (part.error === true) return null;
  const args = inputRecord(part.input);
  if (args === null) return null;
  const given = args["file_path"] ?? args["path"];
  if (typeof given !== "string" || given.length === 0) return null;
  if (part.name === "write") {
    const content = args["content"];
    if (typeof content !== "string") return null;
    return { path: given, range: null, code: content, head: WRITE_HEAD_LINES };
  }
  return { path: given, range: readRange(args), code: part.images === true ? "" : part.output, head: READ_HEAD_LINES };
}

/** A file a tool call names: it opens in the viewer where one can, and reads as text elsewhere. */
export function ToolFile({ path, suffix }: { path: string; suffix?: string }) {
  const t = useT();
  const open = useContext(OpenFileContext);
  if (open === null) return <p className="chat-tool-file">{path}{suffix}</p>;
  return <p className="chat-tool-file"><button type="button" className="chat-tool-file-link" title={t("Open {path}", { path })} onClick={() => open(path)}>{path}</button>{suffix}</p>;
}

/**
 * A file body: the chip that opens it, the range a read covered, and its lines in the code block's
 * own colours. A body longer than its head folds to it, as a long code block does (RD §Work block).
 */
export function ToolFileBody({ path, range, code, head }: FileBody) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => code.split("\n"), [code]);
  return <div className="chat-tool-file-body">
    <ToolFile path={path} />
    {range !== null && <p className="chat-tool-range">{t("Lines {range}", { range })}</p>}
    {code.length > 0 && <div className="markdown-code">
      <HighlightedCode code={expanded ? code : lines.slice(0, head).join("\n")} language={languageForPath(path)} limit={CHAT_HIGHLIGHT_LIMIT} />
      {lines.length > head && <button type="button" className="markdown-code-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? t("Show less") : t("Show all {n} lines", { n: lines.length })}
      </button>}
    </div>}
  </div>;
}

/** The Stop a running call's card offers: a ghost button, its words alone. */
export function ToolStop({ onAbort }: { onAbort: () => void }) {
  const t = useT();
  return <button type="button" className="btn btn-ghost chat-tool-stop" onClick={onAbort}>{t("Stop")}</button>;
}

/**
 * A cut output's way to the whole of it (DS §4.6): pi keeps the rest in a file, which opens where
 * the card opens any other path. Where nothing can open a file it names the path instead.
 */
export function ToolOutputCut({ path }: { path: string }) {
  const t = useT();
  const open = useContext(OpenFileContext);
  return <p className="chat-tool-cut">{t("Output cut")}{" · "}{open === null
    ? <span className="chat-tool-cut-path">{path}</span>
    : <button type="button" className="chat-tool-file-link" onClick={() => open(path)}>{t("Open full output")}</button>}</p>;
}

/**
 * A question pi asked and had answered (DS §4.6): each question over the option that was picked
 * and, where it showed one, that option's preview; a question nobody answered says so.
 */
export function AskedCard({ answers }: { answers: readonly AskedAnswer[] }) {
  const t = useT();
  return <div className="chat-asked">{answers.map((answer, index) => <section key={index} className="chat-ask-question">
    {answer.question.header !== null && <p className="chat-ask-header">{answer.question.header}</p>}
    <p className="chat-ask-text">{answer.question.question}</p>
    {answer.picks.length === 0
      ? <p className="chat-ask-meta">{t("No answer")}</p>
      : <ul className="chat-asked-picks">{answer.picks.map((pick, at) => <li key={at} className="pill chat-asked-pick">{pick}</li>)}</ul>}
    {answer.preview !== null && <pre className="chat-ask-preview">{answer.preview}</pre>}
  </section>)}</div>;
}
