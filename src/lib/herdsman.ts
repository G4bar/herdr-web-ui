/**
 * The Herdsman roster's pure part: what the composer chip counts, which rows the popover draws
 * (sections, tree depth, folds) and which state changes are worth announcing
 * (design/pi-native-chat/DESIGN.md §4.8). It reads only the snapshot the server parsed, so the
 * client never sees the raw status string.
 */
import type { HerdsmanAgent, HerdsmanAgentState, PiNativeHerdsman } from "../../shared/protocol.ts";

export type HerdsmanSection = "asks" | "running" | "finished" | "closed";

export interface HerdsmanCounts {
  total: number;
  running: number;
  asking: number;
}

export interface HerdsmanRow {
  agent: HerdsmanAgent;
  section: HerdsmanSection;
  depth: number;
  hasChildren: boolean;
  folded: boolean;
  deeper: number;
}

export interface HerdsmanFolds {
  sections?: readonly HerdsmanSection[];
  labels?: readonly string[];
}

export interface HerdsmanChange {
  label: string;
  state: "asks" | "finished" | "failed";
}

/** The section a row is drawn in, in the popover's order. */
const SECTION_RANK: Record<HerdsmanSection, number> = { asks: 0, running: 1, finished: 2, closed: 3 };
const CHANGE_RANK: Record<HerdsmanChange["state"], number> = { asks: 0, failed: 1, finished: 2 };
/** Depth 3 is the last one drawn; a row there summarises the rest as `+n deeper`. */
const MAX_DEPTH = 3;

function isLive(state: HerdsmanAgentState): boolean {
  return state === "starting" || state === "running" || state === "asks";
}

function sectionOf(state: HerdsmanAgentState): HerdsmanSection {
  switch (state) {
    case "asks":
      return "asks";
    case "starting":
    case "running":
      return "running";
    case "closed":
      return "closed";
    default:
      return "finished";
  }
}

/** The agents as the roster may draw them: two agents sharing a label would read as one row, so the first wins. */
function firstByLabel(agents: readonly HerdsmanAgent[]): Map<string, HerdsmanAgent> {
  const byLabel = new Map<string, HerdsmanAgent>();
  for (const agent of agents) if (!byLabel.has(agent.label)) byLabel.set(agent.label, agent);
  return byLabel;
}

function compareLabel(a: HerdsmanAgent, b: HerdsmanAgent): number {
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/** Asks wait longest first, running started longest ago first, finished and closed newest first, unknown times last. */
function compareAgents(a: HerdsmanAgent, b: HerdsmanAgent): number {
  const rank = SECTION_RANK[sectionOf(a.state)] - SECTION_RANK[sectionOf(b.state)];
  if (rank !== 0) return rank;
  const section = sectionOf(a.state);
  const descending = section === "finished" || section === "closed";
  const left = (descending ? a.endedAt : a.startedAt) ?? null;
  const right = (descending ? b.endedAt : b.startedAt) ?? null;
  if (left === null || right === null) {
    if (left !== right) return left === null ? 1 : -1;
  } else if (left !== right) return descending ? right - left : left - right;
  return compareLabel(a, b);
}

/** A root is the lead, an agent whose parent is unknown, or one whose ancestor walk comes back to itself. */
function isRoot(agent: HerdsmanAgent, byLabel: ReadonlyMap<string, HerdsmanAgent>): boolean {
  const parent = agent.parent;
  if (parent === null || parent === agent.label || !byLabel.has(parent)) return true;
  const walked = new Set<string>();
  let label: string | null = parent;
  while (label !== null && byLabel.has(label)) {
    if (label === agent.label) return true;
    if (walked.has(label)) return false;
    walked.add(label);
    label = byLabel.get(label)?.parent ?? null;
  }
  return false;
}

function descendants(label: string, children: ReadonlyMap<string, readonly HerdsmanAgent[]>): number {
  const seen = new Set<string>([label]);
  const stack = [...(children.get(label) ?? [])];
  while (stack.length > 0) {
    const agent = stack.pop()!;
    if (seen.has(agent.label)) continue;
    seen.add(agent.label);
    stack.push(...(children.get(agent.label) ?? []));
  }
  return seen.size - 1;
}

export function herdsmanCounts(herdsman: PiNativeHerdsman | null): HerdsmanCounts {
  const agents = herdsman ? herdsman.agents : [];
  return {
    total: agents.length,
    running: agents.filter((agent) => agent.state === "starting" || agent.state === "running").length,
    asking: agents.filter((agent) => agent.state === "asks").length,
  };
}

export function herdsmanRows(herdsman: PiNativeHerdsman | null, folds: HerdsmanFolds = {}): HerdsmanRow[] {
  const byLabel = firstByLabel(herdsman ? herdsman.agents : []);
  const ordered = [...byLabel.values()].sort(compareAgents);
  const children = new Map<string, HerdsmanAgent[]>();
  for (const agent of ordered) {
    const parent = agent.parent;
    if (parent === null || parent === agent.label || !byLabel.has(parent)) continue;
    const siblings = children.get(parent);
    if (siblings) siblings.push(agent);
    else children.set(parent, [agent]);
  }
  const foldedSections = new Set<HerdsmanSection>(folds.sections ?? []);
  const foldedLabels = new Set<string>(folds.labels ?? []);
  const drawn = new Set<string>();
  const rows: HerdsmanRow[] = [];
  const walk = (agent: HerdsmanAgent, depth: number): void => {
    if (drawn.has(agent.label)) return;
    drawn.add(agent.label);
    const kids = children.get(agent.label) ?? [];
    const folded = foldedLabels.has(agent.label);
    rows.push({ agent, section: sectionOf(agent.state), depth, hasChildren: kids.length > 0, folded, deeper: depth === MAX_DEPTH ? descendants(agent.label, children) : 0 });
    if (depth >= MAX_DEPTH || folded) return;
    for (const kid of kids) walk(kid, depth + 1);
  };
  for (const root of ordered) {
    if (!isRoot(root, byLabel) || foldedSections.has(sectionOf(root.state))) continue;
    walk(root, 0);
  }
  return rows;
}

export function herdsmanChanges(previous: PiNativeHerdsman | null, next: PiNativeHerdsman | null): HerdsmanChange[] {
  if (!previous || !next) return [];
  const before = firstByLabel(previous.agents);
  const seen = new Set<string>();
  const changes: HerdsmanChange[] = [];
  for (const agent of next.agents) {
    if (seen.has(agent.label)) continue;
    seen.add(agent.label);
    const prior = before.get(agent.label);
    if (!prior || prior.state === agent.state) continue;
    if (agent.state === "asks" || agent.state === "finished" || agent.state === "failed") changes.push({ label: agent.label, state: agent.state });
  }
  return changes.sort((a, b) => CHANGE_RANK[a.state] - CHANGE_RANK[b.state]);
}

export function herdsmanElapsedMs(agent: HerdsmanAgent, now: number): number | null {
  if (agent.startedAt === undefined) return null;
  const end = agent.endedAt ?? (isLive(agent.state) ? now : undefined);
  if (end === undefined) return null;
  return Math.max(0, end - agent.startedAt);
}

/** The roster ticks its elapsed times only while something can still move. */
export function herdsmanLive(herdsman: PiNativeHerdsman | null): boolean {
  return herdsman ? herdsman.agents.some((agent) => isLive(agent.state)) : false;
}
