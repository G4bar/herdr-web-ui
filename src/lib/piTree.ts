/**
 * Pi's session tree as its RPC answers it (`get_tree`, docs/rpc-commands.md): the same rows, folds and
 * filters pi's own `/tree` TUI shows, in the web's shapes. Pi's RPC has no in-place navigation (PLAN
 * D5), so a row here is only ever something to read or a user message to fork from — nothing reorders
 * the file. The words a row is drawn with are the component's (each theme's own language); this module
 * only says which entry, how deep, folded or not, and its own recorded text.
 */

/** One session entry, as far as the tree reads it: pi records the rest and the tree never looks. */
export interface PiTreeEntry {
  id: string;
  parentId?: string | null;
  type?: string;
  timestamp?: string;
  /** a `label` entry's own text, and `custom_message`'s and `compaction`'s words */
  label?: string;
  summary?: string;
  customType?: string;
  name?: string;
  modelId?: string;
  thinkingLevel?: string;
  message?: {
    role?: string;
    /** a user or assistant message's blocks, or its plain string */
    content?: unknown;
    /** a tool result's tool */
    toolName?: string;
    /** a `bashExecution`'s line */
    command?: string;
    stopReason?: string;
    errorMessage?: string;
  };
}

/** One node of `get_tree`: the entry, the child nodes, and pi's label for the position. */
export interface PiTreeNode {
  entry: PiTreeEntry;
  children?: PiTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

/** `get_tree`'s data: an array, because a navigation can leave orphaned entries as roots of their own. */
export interface PiTreeAnswer {
  tree?: PiTreeNode[];
  leafId?: string | null;
}

/** Pi's five tree views, in the order Ctrl+O cycles them (docs/keybindings.md). */
export type PiTreeFilter = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export const PI_TREE_FILTERS: readonly PiTreeFilter[] = ["default", "no-tools", "user-only", "labeled-only", "all"];

/** The next view in the cycle; `step` -1 is Shift+Ctrl+O. */
export function nextPiTreeFilter(filter: PiTreeFilter, step: 1 | -1 = 1): PiTreeFilter {
  const at = PI_TREE_FILTERS.indexOf(filter);
  return PI_TREE_FILTERS[(at + step + PI_TREE_FILTERS.length) % PI_TREE_FILTERS.length]!;
}

/**
 * The view a Ctrl+letter asks for, as pi binds them: Ctrl+D is always Default, and each other filter is
 * a toggle back to it, so a second press of the same key returns. Null for a key pi binds to nothing.
 * `Ctrl+O` cycles forward and `Shift+Ctrl+O` backward; both arrive as the key "o".
 */
export function piTreeFilterKey(filter: PiTreeFilter, key: string, shift = false): PiTreeFilter | null {
  switch (key.toLowerCase()) {
    case "d": return "default";
    case "t": return filter === "no-tools" ? "default" : "no-tools";
    case "u": return filter === "user-only" ? "default" : "user-only";
    case "l": return filter === "labeled-only" ? "default" : "labeled-only";
    case "a": return filter === "all" ? "default" : "all";
    case "o": return nextPiTreeFilter(filter, shift ? -1 : 1);
    default: return null;
  }
}

/** Which of a row's words the role prefix names; a bookkeeping entry has none of the three. */
export type PiTreeRole = "user" | "assistant" | "tool" | "other";

/** One line of the tree, already flat: the component draws it and nothing else. */
export interface PiTreeRow {
  id: string;
  /** the entry type pi recorded (`message`, `compaction`, `label`, …): a row's own words are the component's */
  kind: string;
  role: PiTreeRole;
  /** the entry's own text: a message's words, a tool's name, a summary; "" when it carries none */
  text: string;
  /** the timestamp pi recorded, as recorded */
  ts: string | null;
  label: string | null;
  labelTimestamp: string | null;
  /** indent in the visible tree: an entry filtered out above does not indent its children */
  depth: number;
  /** per level above, whether a guide line runs on below this row */
  guides: boolean[];
  /** this row has visible children and is where a branch segment starts: the only rows that fold */
  foldable: boolean;
  folded: boolean;
  /** visible entries this row's fold hides */
  hidden: number;
  /** pi's leaf: where the conversation is now */
  current: boolean;
  /** on the path from a root to the leaf: the conversation as it stands */
  active: boolean;
  /** a message the user sent: the only row `fork` takes (pi refuses any other entry id) */
  forking: boolean;
}

export interface PiTreeViewOptions {
  filter?: PiTreeFilter;
  /** free text: every whitespace-separated word has to appear in the row */
  query?: string;
  folded?: ReadonlySet<string>;
}

/** Bookkeeping pi keeps beside the conversation; the default view hides it, `all` shows it. */
const SETTINGS_KINDS = new Set(["label", "context_edit", "custom", "model_change", "thinking_level_change", "session_info"]);
const ROW_TEXT_CHARS = 200;

/** One line of text out of a message's blocks: no newlines, no repeated spaces, cut to a row. */
function squeeze(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ROW_TEXT_CHARS ? `${flat.slice(0, ROW_TEXT_CHARS - 1).trimEnd()}…` : flat;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    const part = block as { type?: unknown; text?: unknown };
    return part.type === "text" && typeof part.text === "string" ? part.text : "";
  }).join(" ");
}

/** The role a row is prefixed with, and the entry's own words for it. */
function entryLine(entry: PiTreeEntry): { role: PiTreeRole; text: string } {
  if (entry.type !== "message") {
    // a bookkeeping entry's own value, in whichever field pi recorded it
    const own = entry.summary ?? entry.label ?? entry.name ?? entry.modelId ?? entry.thinkingLevel ?? entry.customType ?? "";
    return { role: "other", text: squeeze(own) };
  }
  const message = entry.message ?? {};
  switch (message.role) {
    case "user": return { role: "user", text: squeeze(messageText(message.content)) };
    case "assistant": return { role: "assistant", text: squeeze(messageText(message.content)) };
    case "toolResult": return { role: "tool", text: squeeze(message.toolName ?? "tool") };
    case "bashExecution": return { role: "tool", text: squeeze(message.command ?? "") };
    default: return { role: "other", text: "" };
  }
}

/**
 * An assistant entry that only carried tool calls: pi hides it, so a finished tool does not appear twice
 * (its call and its row). The leaf is always shown, and so is one that stopped with an error or an abort.
 */
function silencedAssistant(entry: PiTreeEntry): boolean {
  if (entry.type !== "message" || entry.message?.role !== "assistant") return false;
  if (squeeze(messageText(entry.message.content)) !== "") return false;
  const stop = entry.message.stopReason;
  return stop === undefined || stop === "stop" || stop === "toolUse";
}

/** The entries on the path from `leafId` back to its root: the conversation as the chat shows it. */
function activeIds(nodes: readonly PiTreeNode[], leafId: string | null): Set<string> {
  const parents = new Map<string, string | null>();
  const walk = (list: readonly PiTreeNode[]): void => {
    for (const node of list) {
      parents.set(node.entry.id, node.entry.parentId ?? null);
      walk(node.children ?? []);
    }
  };
  walk(nodes);
  const active = new Set<string>();
  for (let id = leafId; id !== null && !active.has(id); id = parents.get(id) ?? null) {
    active.add(id);
    if (!parents.has(id)) break;
  }
  return active;
}

interface Flat {
  node: PiTreeNode;
}

/** Every node in pi's own order: pre-order, with the child leading to the leaf first. */
function flatten(nodes: readonly PiTreeNode[], active: ReadonlySet<string>): Flat[] {
  const flat: Flat[] = [];
  const visit = (list: readonly PiTreeNode[]): void => {
    const ordered = [...list].sort((a, b) => Number(active.has(b.entry.id)) - Number(active.has(a.entry.id)));
    for (const node of ordered) {
      flat.push({ node });
      visit(node.children ?? []);
    }
  };
  visit(nodes);
  return flat;
}

/** Whether a row is in this view, before a fold takes it away. */
function passes(node: PiTreeNode, filter: PiTreeFilter, leafId: string | null, tokens: readonly string[]): boolean {
  const entry = node.entry;
  // pi records usage beside the conversation; no view ever shows it
  if (entry.type === "usage") return false;
  if (entry.id !== leafId && silencedAssistant(entry)) return false;
  const role = entry.message?.role;
  switch (filter) {
    case "user-only": if (entry.type !== "message" || role !== "user") return false; break;
    case "no-tools": if (SETTINGS_KINDS.has(entry.type ?? "message") || role === "toolResult") return false; break;
    case "labeled-only": if (node.label === undefined) return false; break;
    case "all": break;
    default: if (SETTINGS_KINDS.has(entry.type ?? "message")) return false;
  }
  if (tokens.length === 0) return true;
  const { role: kind, text } = entryLine(entry);
  const searchable = `${node.label ?? ""} ${kind} ${text} ${entry.type ?? ""}`.toLowerCase();
  return tokens.every((token) => searchable.includes(token));
}

/**
 * The tree as one flat list of rows: filtered, searched, folded, and indented where the view puts them.
 * A row whose parent was filtered out hangs under its nearest visible ancestor, as pi reattaches it, so
 * filtering the tool results does not lose a message that answered one.
 */
export function piTreeRows(answer: PiTreeAnswer | null | undefined, options: PiTreeViewOptions = {}): PiTreeRow[] {
  const nodes = answer?.tree ?? [];
  if (nodes.length === 0) return [];
  const leafId = answer?.leafId ?? null;
  const filter = options.filter ?? "default";
  const folded = options.folded ?? new Set<string>();
  const tokens = (options.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const active = activeIds(nodes, leafId);
  const flat = flatten(nodes, active);
  const kept = flat.filter((item) => passes(item.node, filter, leafId, tokens));
  const parentById = new Map(flat.map((item) => [item.node.entry.id, item.node.entry.parentId ?? null]));
  const keptIds = new Set(kept.map((item) => item.node.entry.id));
  // each visible row's place in the visible tree: its nearest kept ancestor, and the kept rows under it
  const visibleParent = new Map<string, string | null>();
  const visibleChildren = new Map<string | null, Flat[]>();
  const childrenUnder = (parentId: string | null): Flat[] => visibleChildren.get(parentId) ?? [];
  for (const item of kept) {
    let parent = parentById.get(item.node.entry.id) ?? null;
    while (parent !== null && !keptIds.has(parent)) parent = parentById.get(parent) ?? null;
    visibleParent.set(item.node.entry.id, parent);
    visibleChildren.set(parent, [...childrenUnder(parent), item]);
  }
  const rows: PiTreeRow[] = [];
  const emit = (item: Flat, depth: number, guides: boolean[]): void => {
    const entry = item.node.entry;
    const { role, text } = entryLine(entry);
    const children = childrenUnder(entry.id);
    // pi folds only where a branch segment starts: a root, or one of several branches
    const siblings = childrenUnder(visibleParent.get(entry.id) ?? null);
    const foldable = children.length > 0 && (depth === 0 || siblings.length > 1);
    const isFolded = foldable && folded.has(entry.id);
    const hidden = isFolded ? children.reduce((count, child) => count + 1 + descendantCount(child, visibleChildren), 0) : 0;
    rows.push({
      id: entry.id,
      kind: entry.type ?? "message",
      role,
      text,
      ts: entry.timestamp ?? null,
      label: item.node.label ?? null,
      labelTimestamp: item.node.labelTimestamp ?? null,
      depth,
      guides,
      foldable,
      folded: isFolded,
      hidden,
      current: entry.id === leafId,
      active: active.has(entry.id),
      forking: role === "user",
    });
    if (isFolded) return;
    children.forEach((child, at) => emit(child, depth + 1, [...guides, at < children.length - 1]));
  };
  // a root has no level above it, so no guide column hangs over it
  for (const root of childrenUnder(null)) emit(root, 0, []);
  return rows;
}

/** The visible rows under one row, however deep: what a fold is hiding. */
function descendantCount(item: Flat, visibleChildren: ReadonlyMap<string | null, Flat[]>): number {
  const children = visibleChildren.get(item.node.entry.id) ?? [];
  return children.reduce((count, child) => count + 1 + descendantCount(child, visibleChildren), 0);
}
