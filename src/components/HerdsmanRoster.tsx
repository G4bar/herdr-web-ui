/**
 * The Herdsman roster: the delegation tree a native Pi session publishes as its `herdsman` status
 * (design/pi-native-chat/DESIGN.md §4.8). The rows, their order and the folds they leave come from
 * `herdsmanRows` (src/lib/herdsman.ts); this file owns the two fold sets, draws the rows and hands a
 * row's label to the agent panel. The chip that opens this in its popover comes next (slice 4).
 */
import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, CircleX, MessageCircle } from "lucide-react";

import "./HerdsmanRoster.css";

import type { HerdsmanAgent, HerdsmanAgentState, PiNativeHerdsman } from "../../shared/protocol.ts";
import { herdsmanElapsedMs, herdsmanRows, type HerdsmanRow, type HerdsmanSection } from "../lib/herdsman.ts";
import { useT } from "../lib/i18n.ts";
import { formatElapsed } from "../lib/omoTasks.ts";

/** The sections in the order the popover draws them. */
const SECTIONS: readonly HerdsmanSection[] = ["asks", "running", "finished", "closed"];

/**
 * The rows grouped under their subtree root's section: `herdsmanRows` walks depth first, so a child
 * follows its parent and a delegate stays nested with it instead of moving to its own state's section.
 */
function groupsByRoot(rows: readonly HerdsmanRow[]): Map<HerdsmanSection, HerdsmanRow[]> {
  const groups = new Map<HerdsmanSection, HerdsmanRow[]>();
  let section: HerdsmanSection | null = null;
  for (const row of rows) {
    if (row.depth === 0) section = row.section;
    if (section === null) continue;
    const group = groups.get(section);
    if (group) group.push(row);
    else groups.set(section, [row]);
  }
  return groups;
}

const STATE_ICON: Record<HerdsmanAgentState, typeof Circle> = {
  starting: CircleDot,
  running: CircleDot,
  asks: MessageCircle,
  finished: CircleCheck,
  failed: CircleX,
  stale: Circle,
  closed: Circle,
};

export function HerdsmanRoster({ herdsman, now, onOpenAgent }: { herdsman: PiNativeHerdsman; now: number; onOpenAgent?: (label: string) => void }) {
  const t = useT();
  const [sections, setSections] = useState<ReadonlySet<HerdsmanSection>>(() => new Set());
  const [labels, setLabels] = useState<ReadonlySet<string>>(() => new Set());

  const toggleSection = (section: HerdsmanSection): void => {
    setSections((current) => {
      const next = new Set(current);
      if (!next.delete(section)) next.add(section);
      return next;
    });
  };
  const toggleLabel = (label: string): void => {
    setLabels((current) => {
      const next = new Set(current);
      if (!next.delete(label)) next.add(label);
      return next;
    });
  };

  /**
   * Left folds the focused row's children, or its section when it has none; right unfolds the same.
   * The fold state is read back from the element that draws it, so the arrow never disagrees with
   * the header or the row. A row's section can only fold by unmounting that row, so the section
   * header takes the focus there; a header and a row with children stay where they are.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const wantsOpen = event.key === "ArrowRight";
    const element = ((event.target as HTMLElement | null)?.closest?.("[data-hm-section]") ?? null) as HTMLElement | null;
    const section = element?.dataset["hmSection"] as HerdsmanSection | undefined;
    if (!element || section === undefined) return;
    const label = element.dataset["hmLabel"];
    // the row that folds its own children, the section header, or the header a childless row folds
    const head = label === undefined || element.getAttribute("aria-expanded") !== null
      ? element
      : event.currentTarget.querySelector<HTMLElement>(`.hm-section[data-hm-section="${section}"]`);
    if (!head || (head.getAttribute("aria-expanded") === "true") === wantsOpen) return;
    if (head === element && label !== undefined) toggleLabel(label);
    else toggleSection(section);
    if (head !== element) head.focus();
  };

  if (herdsman.agents.length === 0) return <p className="bg-tasks-note">{t("No agents yet. Pi starts them when it delegates work.")}</p>;

  const stateWords: Record<HerdsmanAgentState, string> = {
    starting: t("Starting"),
    running: t("Running"),
    asks: t("Asks you"),
    finished: t("Finished"),
    failed: t("Failed"),
    stale: t("Not responding"),
    closed: t("Closed"),
  };
  const sectionWords: Record<HerdsmanSection, string> = { asks: t("Asks you"), running: t("Running"), finished: t("Finished"), closed: t("Closed") };

  // a folded section or label draws no row, so the counts a header shows come from the whole tree
  const counts = groupsByRoot(herdsmanRows(herdsman));
  const groups = groupsByRoot(herdsmanRows(herdsman, { sections: [...sections], labels: [...labels] }));

  const rowView = (row: HerdsmanRow, section: HerdsmanSection) => {
    const agent: HerdsmanAgent = row.agent;
    const Icon = STATE_ICON[agent.state];
    const elapsed = herdsmanElapsedMs(agent, now);
    const activity = agent.state === "running" ? agent.activity?.at(-1) : undefined;
    const meta = activity ?? agent.task ?? stateWords[agent.state];
    // the treeitem is the row itself, so what it folds and what it announces sit on the focus target
    const shared = {
      className: "hm-row",
      role: "treeitem" as const,
      "aria-level": row.depth + 2,
      "aria-expanded": row.hasChildren ? !row.folded : undefined,
      "data-hm-label": agent.label,
      "data-hm-section": section,
      "data-hm-depth": row.depth,
      style: { "--hm-depth": row.depth } as CSSProperties,
    };
    const content = <>
      <Icon className={`hm-row-icon is-${agent.state}`} aria-hidden="true" />
      <span className="hm-row-label">{agent.label}</span>
      <span className="pill">{agent.definition}</span>
      <span className="hm-row-meta" title={meta}>{meta}</span>
      {row.deeper > 0 && <span className="hm-deeper">{t("+{n} deeper", { n: row.deeper })}</span>}
      {elapsed !== null && <span className="hm-row-time">{formatElapsed(elapsed)}</span>}
      <span className="sr-only">{stateWords[agent.state]}</span>
    </>;
    // until the agent panel exists (slice 5) a row only tells; it becomes a button when it can open one
    return (
      <li key={agent.label} role="none">
        {onOpenAgent === undefined
          ? <div {...shared}>{content}</div>
          : <button type="button" {...shared} onClick={() => onOpenAgent(agent.label)}>{content}</button>}
      </li>
    );
  };

  return (
    <ul className="hm-tree" role="tree" aria-label={t("Agents")} onKeyDown={onKeyDown}>
      {SECTIONS.map((section) => {
        const group = counts.get(section) ?? [];
        if (group.length === 0) return null;
        const folded = sections.has(section);
        return [
          <li key={`section-${section}`} role="none">
            <button type="button" role="treeitem" className="hm-section" data-hm-section={section} aria-level={1} aria-expanded={!folded} onClick={() => toggleSection(section)}>
              {folded ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              <span>{sectionWords[section]}</span>
              <span className="hm-section-count">{group.length}</span>
            </button>
          </li>,
          // a folded section's rows are absent from this read
          ...(groups.get(section) ?? []).map((row) => rowView(row, section))
        ];
      })}
    </ul>
  );
}
