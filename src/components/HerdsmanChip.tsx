/**
 * The composer's Agents chip and the roster it opens (design/pi-native-chat/DESIGN.md §4.8): how
 * many Herdsman agents the session runs, how many wait for the owner, and their delegation tree.
 * The chip is the Plan chip's skin (BackgroundTasks.css) and the roster takes the Plan list's slot;
 * the state changes it announces go to the chat's persistent status container (§8.3), never the
 * roster's churn. The composer places the chip beside the Plan one; a session without agents draws
 * nothing.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Users } from "lucide-react";

import "./HerdsmanChip.css";

import type { HerdsmanAgentState, PiNativeHerdsman } from "../../shared/protocol.ts";
import { herdsmanChanges, herdsmanCounts, herdsmanLive, herdsmanRows } from "../lib/herdsman.ts";
import { useT } from "../lib/i18n.ts";
import { HerdsmanRoster } from "./HerdsmanRoster.tsx";

/** The states whose agents are done: what the chip counts when nothing runs and nobody asks. */
const DONE: readonly HerdsmanAgentState[] = ["finished", "failed", "stale"];

export function HerdsmanChip({ herdsman, onOpenAgent, onAnnounce }: {
  herdsman: PiNativeHerdsman | null;
  onOpenAgent?: (label: string) => void;
  onAnnounce?: (text: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  /** the snapshot the next one is compared with: the first one announces nothing */
  const previous = useRef<PiNativeHerdsman | null>(null);
  const live = herdsmanLive(herdsman);

  // a finished agent, a failed one or a question is worth a word; running, closing and stale are not
  useEffect(() => {
    const changes = herdsmanChanges(previous.current, herdsman);
    previous.current = herdsman;
    if (changes.length === 0 || !onAnnounce) return;
    onAnnounce(changes.map((change) => change.state === "asks"
      ? t("{label} asks you", { label: change.label })
      : change.state === "finished" ? t("{label} finished", { label: change.label }) : t("{label} failed", { label: change.label })).join(" · "));
  }, [herdsman, onAnnounce, t]);

  // the elapsed times tick only while the roster is open and an agent can still gain time
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, live]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // the roster unmounts with whatever inside it held the focus: hand it back to the toggle
      if (root.current?.contains(document.activeElement)) toggle.current?.focus();
      setOpen(false);
    };
    // the roster shares its place above the card with the slash and @ menus: once the focus has
    // gone elsewhere it closes, or it would cover them
    const left = (event: FocusEvent): void => { if (event.relatedTarget instanceof Node && !node?.contains(event.relatedTarget)) setOpen(false); };
    const node = root.current;
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    node?.addEventListener("focusout", left);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); node?.removeEventListener("focusout", left); };
  }, [open]);

  if (herdsman === null || herdsman.agents.length === 0) return null;

  const counts = herdsmanCounts(herdsman);
  const done = herdsman.agents.filter((agent) => DONE.includes(agent.state)).length;
  // what runs and what waits, or what ended once nothing does: the header's line and the chip's title
  const countsLine = [
    counts.running > 0 ? t("{n} running", { n: counts.running }) : null,
    counts.asking > 0 ? t("{n} asks you", { n: counts.asking }) : null,
  ].filter((part) => part !== null).join(" · ") || t("{n} finished", { n: done });
  const idle = counts.running === 0 && counts.asking === 0;

  return <span className="bg-tasks" ref={root}>
    <button type="button" ref={toggle} className={`bg-tasks-toggle hm-chip${idle ? " is-idle" : ""}`} aria-label={t("Agents: {n}, {k} waiting for you", { n: counts.total, k: counts.asking })} title={countsLine} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <Users aria-hidden="true" />
      <span className="bg-tasks-label">{t("Agents")}</span>
      <span className="bg-tasks-count" aria-hidden="true">{counts.total}</span>
      {counts.asking > 0 && <span className="hm-chip-dot" aria-hidden="true" />}
    </button>
    {open && <div id={id} className="menu bg-tasks-menu hm-menu" role="dialog" aria-label={t("Agents")}>
      <div className="menu-heading hm-head">
        <span>{t("Agents")}</span>
        <span className="hm-head-counts">{countsLine}</span>
        {/* the panel exists from slice 5 on: until then the header offers nothing to open */}
        {onOpenAgent && <button type="button" className="hm-open-panel" onClick={() => onOpenAgent(herdsmanRows(herdsman)[0]?.agent.label ?? "")}>{t("Open panel")}</button>}
      </div>
      <HerdsmanRoster herdsman={herdsman} now={now} onOpenAgent={onOpenAgent} />
    </div>}
  </span>;
}
