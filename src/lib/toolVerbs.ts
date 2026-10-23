import { patchFiles, patchText } from "../../shared/patch.ts";
import { askedQuestions } from "./askQuestions.ts";

/**
 * What a row says the call did: "Read src/a.ts", "Ran bun test", "Called create_issue".
 *
 * The four file and shell kinds keep Codex's and Claude's existing verbs; the rest name one Pi,
 * omo or MCP tool each, because their objects differ (grep found a pattern, find found nothing,
 * ls listed a folder). A kind is one verb + the input fields its object can be, so a guessed verb
 * by substring would call `mcp__files__read_all` a read.
 */
export type ToolVerbKind =
  | "read" | "edit" | "write" | "run"
  | "searched" | "found" | "listed"
  | "todo" | "asked" | "script" | "called"
  | "toolSearch" | "webSearch" | "fetched"
  | "delegated" | "steered" | "interrupted" | "replied" | "closed"
  | "listedAgents" | "askedOwner";

/** What a work row says the call did, before its object: "Read src/a.ts", "Ran bun test". */
const VERB_LABEL: Record<ToolVerbKind, string> = {
  read: "Read",
  edit: "Edited",
  write: "Wrote",
  run: "Ran",
  searched: "Searched",
  found: "Found",
  listed: "Listed",
  todo: "Updated todos",
  asked: "Asked",
  script: "Ran script",
  called: "Called",
  toolSearch: "Searched tools",
  webSearch: "Searched the web",
  fetched: "Fetched",
  delegated: "Delegated",
  steered: "Steered",
  interrupted: "Interrupted",
  replied: "Replied to",
  closed: "Closed",
  listedAgents: "Listed agents",
  askedOwner: "Asked owner",
};

/**
 * The tool ids a verb stands for, by exact name (case aside): Claude's Read / Edit / MultiEdit /
 * NotebookEdit / Write / Bash, Codex's exec / exec_command / shell / local_shell / apply_patch,
 * and the lowercase read / edit / write / bash / patch of pi, omp, gjc and omo. Anything else
 * (Grep, a web or task tool, a todo or goal call, an MCP tool) keeps its own name: a guess by
 * substring would call `mcp__files__read_all` a read.
 *
 * The rows below the shell tools are the Pi chat's own (DS §4.6): one exact id each, so a tool
 * another agent runs under a different name keeps its id in the row.
 */
const VERB_OF: Record<string, ToolVerbKind> = {
  read: "read",
  edit: "edit", multiedit: "edit", notebookedit: "edit", apply_patch: "edit", patch: "edit",
  write: "write",
  bash: "run", exec: "run", exec_command: "run", shell: "run", shell_command: "run", local_shell: "run",
  grep: "searched", find: "found", ls: "listed",
  todo: "todo",
  ask_user_question: "asked",
  codemode: "script",
  tool_search: "toolSearch",
  web_search: "webSearch",
  fetch_content: "fetched",
  delegate_agent: "delegated", continue_agent: "delegated",
  steer_agent: "steered", interrupt_agent: "interrupted", reply_agent: "replied", close_agent: "closed",
  list_agents: "listedAgents",
  ask_owner: "askedOwner",
};

/**
 * The input fields a verb's object can be: a run's command, a file call's path. Empty for a kind
 * whose object is not an input field (a todo list's count, an asked question's header): the row's
 * summary already is that object.
 */
const OBJECT_KEYS: Record<ToolVerbKind, readonly string[]> = {
  read: ["file_path", "path"],
  edit: ["file_path", "notebook_path", "path"],
  write: ["file_path", "path"],
  run: ["cmd", "command"],
  searched: ["pattern", "query"],
  found: ["path", "pattern", "query"],
  listed: ["path"],
  todo: [],
  asked: [],
  script: [],
  called: [],
  toolSearch: ["query"],
  webSearch: ["query"],
  fetched: ["url"],
  delegated: [],
  steered: [],
  interrupted: [],
  replied: [],
  closed: [],
  listedAgents: [],
  askedOwner: [],
};

/** The server cuts a row's summary to this many characters. */
const SUMMARY_LENGTH = 120;

/** The verb a row shows, its object, and the MCP server its pill names. */
export interface ToolCallLabel {
  verb: string;
  /** what follows the verb: the call's summary, a ranged read's lines, or an MCP tool's own name */
  object: string;
  /** an MCP call's server (`mcp__<server>__<tool>`), shown as the opened card's pill */
  server?: string;
}

/**
 * An MCP tool's name and server, read from its id alone: `mcp__<server>__<tool>`. The summary of
 * such a call is often just its id, so the row would otherwise say nothing about what was called.
 */
export function mcpTarget(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match === null ? null : { server: match[1]!, tool: match[2]! };
}

/** The kind of verb a tool id reads as, or null for a tool the table does not know. */
export function toolVerbKind(name: string, input = ""): ToolVerbKind | null {
  if (mcpTarget(name) !== null) return "called";
  const key = name.toLowerCase();
  if (!Object.hasOwn(VERB_OF, key)) return null;
  const kind = VERB_OF[key]!;
  // Codex applies a patch from inside an exec script: the row names the files, so it is an edit.
  // The patch is found by its text, so a `tools.apply_patch("…")` the script only quotes or
  // comments out reads as an edit too, as it already does in the row's file list and diff.
  return kind === "run" && patchText(input) !== null ? "edit" : kind;
}

/**
 * Whether a row's summary is the thing the call acted on: its command or path, or the files of
 * its patch. omp sums a call up by its `intent` ("Checking ports") instead, and a verb in front
 * of that sentence would read "Ran Checking ports".
 */
function isObjectOf(kind: ToolVerbKind, input: string, object: string): boolean {
  const keys = OBJECT_KEYS[kind];
  // a kind whose object is not a field (a todo count, an asked header) trusts the summary it is handed
  if (keys.length === 0) return true;
  const patch = patchText(input);
  if (patch !== null && patchFiles(patch).join(", ").slice(0, SUMMARY_LENGTH) === object) return true;
  let args: unknown;
  try { args = JSON.parse(input); } catch { return false; }
  if (typeof args !== "object" || args === null) return false;
  return keys.some((key) => {
    const value = (args as Record<string, unknown>)[key];
    return typeof value === "string" && value.slice(0, SUMMARY_LENGTH) === object;
  });
}

/** The lines a ranged read covers: offset is 1-indexed, limit counts from it. */
function readRange(input: string, object: string): string {
  let args: unknown;
  try { args = JSON.parse(input); } catch { return object; }
  if (typeof args !== "object" || args === null) return object;
  const record = args as Record<string, unknown>;
  const limit = typeof record["limit"] === "number" && record["limit"] > 0 ? Math.floor(record["limit"]) : null;
  const offset = typeof record["offset"] === "number" && record["offset"] > 0 ? Math.floor(record["offset"]) : limit === null ? null : 1;
  if (offset === null) return object;
  return `${object} ${offset}–${limit === null ? "" : offset + limit - 1}`;
}

/** The object a call shows when its summary is only the tool's name: an asked question's header. */
function derivedObject(part: { name: string; input: string }): string | null {
  if (part.name.toLowerCase() !== "ask_user_question") return null;
  let args: unknown;
  try { args = JSON.parse(part.input); } catch { return null; }
  const first = askedQuestions(part.name, args)?.[0];
  return first === undefined ? null : first.header ?? first.question.split("\n")[0]!.trim();
}

/** The input fields an agent says a call's purpose in: OmO's eval, Claude's Bash and subagents, omp. */
const NARRATION_KEYS = ["summary", "description", "intent"] as const;

/**
 * Whether a row's summary is the agent's own sentence about the call ("Run the unit tests")
 * rather than its command or path. Such a row says the sentence alone: the tool id in front of
 * it ("eval Run the unit tests") tells the reader nothing, and stays in the title and the detail.
 */
export function isToolNarration(part: { name: string; input: string }, summary: string): boolean {
  if (summary.trim().length === 0 || summary === part.name) return false;
  let args: unknown;
  try { args = JSON.parse(part.input); } catch { return false; }
  if (typeof args !== "object" || args === null) return false;
  return NARRATION_KEYS.some((key) => {
    const value = (args as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim().slice(0, SUMMARY_LENGTH) === summary;
  });
}

/**
 * The verb and object a row shows in place of the tool id, or null when the id stays: an unknown
 * tool, a call with no object to follow the verb, or a summary that is not the call's own command
 * or path. An MCP call is named by its own id, so it reads as the name of the tool it ran.
 */
export function toolCallLabel(part: { name: string; input: string }, object: string): ToolCallLabel | null {
  const mcp = mcpTarget(part.name);
  if (mcp !== null) return { verb: VERB_LABEL.called, object: mcp.tool, server: mcp.server };
  const kind = toolVerbKind(part.name, part.input);
  if (kind === null) return null;
  const derived = derivedObject(part);
  if (derived !== null) return { verb: VERB_LABEL[kind], object: derived };
  if (object.trim().length === 0 || object === part.name) return null;
  if (!isObjectOf(kind, part.input, object)) return null;
  return { verb: VERB_LABEL[kind], object: kind === "read" ? readRange(part.input, object) : object };
}

/** The verb alone, for a caller that already has the object it shows. */
export function toolVerb(part: { name: string; input: string }, object: string): string | null {
  return toolCallLabel(part, object)?.verb ?? null;
}

/** The verb a tool id reads as, for a row with no input to check an object against: a script's nested calls. */
export function toolVerbName(name: string): string | null {
  const kind = toolVerbKind(name);
  return kind === null ? null : VERB_LABEL[kind];
}
