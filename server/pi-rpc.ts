import type { HerdsmanAgent, PiNativeHerdsman, PiNativeModel, PiNativeNotice, PiNativeState, PiNativeStats, PiNativeUiAnswer, PiNativeUiRequest } from "../shared/protocol.ts";
import { PI_NOTICE_MESSAGE_CHARS } from "../shared/protocol.ts";

/**
 * pi driven over its RPC mode (`pi --mode rpc --session <file>`), one child per native pane, and
 * the pure reduction of its event stream into the `PiNativeState` the chat draws.
 *
 * pi owns the turn: the transcript stays the session JSONL the child writes, and this stream says
 * only what a file cannot — the model, the thinking level, the queue, the dialog pi waits on, how
 * a running tool is doing. Everything here is per child; nothing survives it.
 */

/** The newest notices kept: an extension that notifies in a loop must not grow the state. */
export const NOTICE_LIMIT = 20;
/** How much of a running tool's output a tail keeps, and how long each of its lines may be. */
export const TAIL_LINES = 12;
export const TAIL_LINE_CHARS = 400;
/** The widgets kept at once, the lines of each, and how long such a line may be: the composer draws
 * six lines of them, and the oldest key goes when another arrives. */
export const WIDGET_LIMIT = 8;
export const WIDGET_LINES = 6;
export const WIDGET_LINE_CHARS = 500;
/** A stderr line longer than this is cut instead of read whole. */
const STDERR_LINE_CHARS = 400;
/** An exiting child gets this long to dispose its runtime before it is killed. */
const CLOSE_GRACE_MS = 500;

/** Notice ids are ours, not pi's: one counter keeps them distinct however many the cap drops. */
let noticeSequence = 0;
const nextNoticeId = (): string => `notice-${++noticeSequence}`;

const utf8 = new TextDecoder();

/** A notice's text, cut: an extension's own long message must not fill the state. */
const noticeMessage = (value: string): string => value.slice(0, PI_NOTICE_MESSAGE_CHARS);

/** One stdout record: a session event, an `extension_ui_request`, or a response. Only `type` is trusted. */
export type PiRpcRecord = Record<string, unknown>;

export interface PiRpcOptions {
  /** the session file the child reads and writes. Only one writer may hold it at a time. */
  sessionFile: string;
  /** the pane's own folder */
  cwd: string;
  /** the pane's environment: herdr's socket and pane id keep its sidebar and Herdsman working */
  env?: Record<string, string | undefined>;
  /** further CLI arguments, such as `--approve` or `--no-approve` */
  args?: string[];
  /** the program to run, `pi` by default; a test puts a fake Pi here */
  bin?: string[];
  /** where diagnostics and the child's stderr go */
  log?: (line: string) => void;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const object = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? value as Record<string, unknown> : {});
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

/** `value` when it is one of `allowed`, else null: a record's own spelling of a closed set. */
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : null;

const STEERING_MODES = ["all", "one-at-a-time"] as const;
const DIALOG_METHODS = ["select", "confirm", "input", "editor"] as const;
const NOTICE_TYPES = ["info", "warning", "error"] as const;
/** pi puts a widget over the editor unless the extension asks for below it. */
const WIDGET_PLACEMENTS = ["aboveEditor", "belowEditor"] as const;
/** the status key Herdsman publishes its delegation tree under */
const HERDSMAN_KEY = "herdsman";
const HERDSMAN_AGENT_STATES = ["starting", "running", "asks", "finished", "failed", "stale", "closed"] as const;
/** the snapshot version this bridge reads; a newer one is kept out rather than half-read */
const HERDSMAN_SNAPSHOT_VERSION = 1;

/** The model cut to what the chat shows: pi's registry states the rest. */
function modelOf(value: unknown): PiNativeModel | null {
  const model = object(value);
  const id = text(model["id"]);
  if (id === null) return null;
  const window = model["contextWindow"];
  return {
    provider: text(model["provider"]) ?? "",
    id,
    name: text(model["name"]) ?? id,
    contextWindow: typeof window === "number" && window > 0 ? window : null,
    reasoning: model["reasoning"] === true,
  };
}

/** `get_session_stats` kept as pi answers it, its context block optional. */
function statsOf(value: unknown): PiNativeStats | null {
  const stats = object(value);
  if (Object.keys(stats).length === 0) return null;
  const tokens = object(stats["tokens"]);
  const usage = object(stats["contextUsage"]);
  const window = usage["contextWindow"];
  return {
    userMessages: number(stats["userMessages"]),
    assistantMessages: number(stats["assistantMessages"]),
    toolCalls: number(stats["toolCalls"]),
    totalMessages: number(stats["totalMessages"]),
    tokens: {
      input: number(tokens["input"]),
      output: number(tokens["output"]),
      cacheRead: number(tokens["cacheRead"]),
      cacheWrite: number(tokens["cacheWrite"]),
      total: number(tokens["total"]),
    },
    cost: number(stats["cost"]),
    contextUsage: typeof window === "number"
      ? { tokens: typeof usage["tokens"] === "number" ? usage["tokens"] : null, contextWindow: window, percent: typeof usage["percent"] === "number" ? usage["percent"] : null }
      : null,
  };
}

/**
 * The session's totals with one finished message's usage added. `get_session_stats` is the answer
 * for the whole session and replaces these; between its reads this keeps them from standing still
 * while a turn runs. Compaction and summary usage is in neither until that read.
 */
function plusUsage(stats: PiNativeStats, usage: Record<string, unknown>): PiNativeStats {
  const cost = object(usage["cost"]);
  const summed = number(usage["input"]) + number(usage["output"]) + number(usage["cacheRead"]) + number(usage["cacheWrite"]);
  return {
    ...stats,
    tokens: {
      input: stats.tokens.input + number(usage["input"]),
      output: stats.tokens.output + number(usage["output"]),
      cacheRead: stats.tokens.cacheRead + number(usage["cacheRead"]),
      cacheWrite: stats.tokens.cacheWrite + number(usage["cacheWrite"]),
      total: stats.tokens.total + (typeof usage["totalTokens"] === "number" ? number(usage["totalTokens"]) : summed),
    },
    cost: stats.cost + number(cost["total"]),
  };
}

/** Chunks joined in order: a record split across reads is read as the bytes pi wrote it with. */
function joinBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  let length = 0;
  for (const part of parts) length += part.length;
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * The last lines of a tail, each cut: a tool that prints one huge line must not fill the state. The
 * empty last line of output that ended with a newline stays, so a delta that continues a line keeps
 * its place: `one\n` + `two\n` is two lines, while `sec` + `ond\n` is still one.
 */
function tailOf(output: string): string[] {
  return output.split("\n").map((line) => line.slice(0, TAIL_LINE_CHARS)).slice(-TAIL_LINES);
}

/** One agent of the snapshot, or null when its entry names no label or a state this bridge cannot draw. */
function agentOf(value: unknown): HerdsmanAgent | null {
  const entry = object(value);
  const label = text(entry["label"]);
  const state = oneOf(entry["state"], HERDSMAN_AGENT_STATES);
  if (label === null || label === "" || state === null) return null;
  const agent: HerdsmanAgent = { label, definition: text(entry["definition"]) ?? "unknown", parent: text(entry["parent"]), state };
  // an unknown field is left absent rather than filled: the roster draws a missing count as unknown,
  // a zeroed one as a real zero
  const task = text(entry["task"]);
  if (task !== null) agent.task = task;
  const activity = stringList(entry["activity"]);
  if (activity.length > 0) agent.activity = activity;
  const answer = text(entry["answer"]);
  if (answer !== null) agent.answer = answer;
  const resultRef = text(entry["resultRef"]);
  if (resultRef !== null) agent.resultRef = resultRef;
  const counts = ["toolCalls", "tokens", "startedAt", "endedAt"] as const;
  for (const key of counts) {
    const count = entry[key];
    if (typeof count === "number" && Number.isFinite(count)) agent[key] = count;
  }
  const question = object(entry["question"]);
  const questionText = text(question["text"]);
  if (questionText !== null) agent.question = { text: questionText, files: stringList(question["files"]) };
  if (entry["resumable"] === true) agent.resumable = true;
  return agent;
}

/** A malformed snapshot is reported once: an extension that rewrites a broken status must not fill the log. */
let herdsmanMalformedLogged = false;
let herdsmanVersionLogged = false;

/**
 * The `herdsman` status as the roster reads it: null when the extension cleared it, the snapshot when
 * it is readable, and `undefined` when the previous snapshot stands (a record mid-write, or a version
 * this bridge does not know).
 */
function herdsmanOf(statusText: string | null): PiNativeHerdsman | null | undefined {
  if (statusText === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(statusText); } catch {
    if (!herdsmanMalformedLogged) { herdsmanMalformedLogged = true; console.warn("[pi-rpc] herdsman status is not JSON; keeping the previous snapshot"); }
    return undefined;
  }
  const snapshot = object(parsed);
  if (snapshot["v"] !== HERDSMAN_SNAPSHOT_VERSION) {
    if (!herdsmanVersionLogged) { herdsmanVersionLogged = true; console.warn(`[pi-rpc] herdsman snapshot version ${String(snapshot["v"])} is not ${HERDSMAN_SNAPSHOT_VERSION}; keeping the previous snapshot`); }
    return undefined;
  }
  if (!Array.isArray(snapshot["agents"])) {
    if (!herdsmanMalformedLogged) { herdsmanMalformedLogged = true; console.warn("[pi-rpc] herdsman snapshot has no agents array; keeping the previous snapshot"); }
    return undefined;
  }
  return { agents: snapshot["agents"].map(agentOf).filter((agent): agent is HerdsmanAgent => agent !== null), capabilities: stringList(snapshot["capabilities"]) };
}

/** The state of a child that has not said anything yet. */
export function initialPiNativeState(): PiNativeState {
  return {
    mode: "connecting",
    model: null,
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    queue: { steering: [], followUp: [] },
    stats: null,
    retry: null,
    uiRequest: null,
    statuses: {},
    herdsman: null,
    widgets: {},
    notices: [],
    editorText: null,
    toolTails: {},
    sessionFile: null,
    sessionName: null,
  };
}

/** Take `set_editor_text`'s prefill: the composer fills its box once, so the state stops offering it. */
export function consumeEditorText(state: PiNativeState): PiNativeState {
  return state.editorText === null ? state : { ...state, editorText: null };
}

/**
 * The next state after one record. Pure, and the same object when the record changes nothing, so a
 * listener is not told about records the chat ignores. A `response` carries the command it answers
 * in `request`, since commands such as `set_steering_mode` change the state and report nothing back.
 */
export function reducePiEvent(state: PiNativeState, event: PiRpcRecord): PiNativeState {
  switch (text(event["type"]) ?? "") {
    case "response": return reduceResponse(state, event);
    case "extension_ui_request": return reduceUiRequest(state, event);
    /** the answer went back: the dialog stops pending, though pi's next record may be a while */
    case "ui_answered": return state.uiRequest !== null && state.uiRequest.id === text(event["id"]) ? { ...state, uiRequest: null } : state;
    case "agent_start": return { ...state, isStreaming: true };
    case "agent_settled": return { ...state, isStreaming: false };
    case "message_end": return reduceMessageEnd(state, event);
    case "queue_update": return { ...state, queue: { steering: stringList(event["steering"]), followUp: stringList(event["followUp"]) } };
    case "thinking_level_changed": return { ...state, thinkingLevel: text(event["level"]) ?? state.thinkingLevel };
    case "session_info_changed": return { ...state, sessionName: text(event["name"]) };
    case "compaction_start": return { ...state, isCompacting: true };
    case "compaction_end": return reduceCompactionEnd(state, event);
    case "auto_retry_start": return { ...state, retry: { attempt: number(event["attempt"]), maxAttempts: number(event["maxAttempts"]), delayMs: number(event["delayMs"]), errorMessage: text(event["errorMessage"]) ?? "" } };
    case "auto_retry_end": return reduceRetryEnd(state, event);
    case "tool_execution_update": return reduceToolUpdate(state, event);
    case "tool_execution_end": return dropTail(state, text(event["toolCallId"]));
    case "bash_execution_update": return appendBashOutput(state, event);
    /** the child is gone: nothing can be answered any more, so what waited on a person is dropped */
    case "exit": return { ...state, mode: "lost", isStreaming: false, isCompacting: false, retry: null, uiRequest: null };
    default: return state;
  }
}

function reduceResponse(state: PiNativeState, event: PiRpcRecord): PiNativeState {
  const request = object(event["request"]);
  // a refused bash ends too: the output it streamed before the refusal has nowhere left to go
  if (event["success"] !== true) return text(event["command"]) === "bash" ? dropTail(state, text(request["id"])) : state;
  const data = event["data"];
  switch (text(event["command"]) ?? "") {
    case "get_state": {
      const session = object(data);
      return {
        ...state,
        mode: "native",
        model: modelOf(session["model"]) ?? state.model,
        thinkingLevel: text(session["thinkingLevel"]) ?? state.thinkingLevel,
        isStreaming: session["isStreaming"] === true,
        isCompacting: session["isCompacting"] === true,
        steeringMode: oneOf(session["steeringMode"], STEERING_MODES) ?? state.steeringMode,
        followUpMode: oneOf(session["followUpMode"], STEERING_MODES) ?? state.followUpMode,
        sessionFile: text(session["sessionFile"]) ?? state.sessionFile,
        sessionName: text(session["sessionName"]),
      };
    }
    case "get_session_stats": {
      const stats = statsOf(data);
      const file = text(object(data)["sessionFile"]);
      return { ...state, mode: "native", stats: stats ?? state.stats, sessionFile: file ?? state.sessionFile };
    }
    case "set_model": return { ...state, mode: "native", model: modelOf(data) ?? state.model };
    case "cycle_model": {
      const cycle = object(data);
      return { ...state, mode: "native", model: modelOf(cycle["model"]) ?? state.model, thinkingLevel: text(cycle["thinkingLevel"]) ?? state.thinkingLevel };
    }
    case "set_thinking_level": return { ...state, mode: "native", thinkingLevel: text(request["level"]) ?? state.thinkingLevel };
    case "cycle_thinking_level": {
      const level = text(object(data)["level"]);
      return level === null ? state : { ...state, mode: "native", thinkingLevel: level };
    }
    case "set_steering_mode": return { ...state, mode: "native", steeringMode: oneOf(request["mode"], STEERING_MODES) ?? state.steeringMode };
    case "set_follow_up_mode": return { ...state, mode: "native", followUpMode: oneOf(request["mode"], STEERING_MODES) ?? state.followUpMode };
    case "clear_queue": {
      const queue = object(data);
      return { ...state, mode: "native", queue: { steering: stringList(queue["steering"]), followUp: stringList(queue["followUp"]) } };
    }
    /** the command is over, so the output it streamed has nowhere left to go */
    case "bash": return dropTail(state, text(request["id"]));
    default: return state.mode === "native" ? state : { ...state, mode: "native" };
  }
}

function reduceUiRequest(state: PiNativeState, event: PiRpcRecord): PiNativeState {
  const id = text(event["id"]);
  const method = text(event["method"]);
  if (id === null) return state;
  if (oneOf(method, DIALOG_METHODS) !== null) {
    // pi blocks inside one dialog call, so a second request replaces nothing that is still waited on
    const dialog: PiNativeUiRequest = { id, method: method as PiNativeUiRequest["method"], title: text(event["title"]) ?? "", receivedAt: Date.now() };
    const message = text(event["message"]);
    const placeholder = text(event["placeholder"]);
    const prefill = text(event["prefill"]);
    const options = stringList(event["options"]);
    const timeout = event["timeout"];
    if (message !== null) dialog.message = message;
    if (placeholder !== null) dialog.placeholder = placeholder;
    if (prefill !== null) dialog.prefill = prefill;
    if (options.length > 0) dialog.options = options;
    if (typeof timeout === "number") dialog.timeout = timeout;
    return { ...state, uiRequest: dialog };
  }
  switch (method) {
    case "notify": {
      const notice: PiNativeNotice = { id, type: oneOf(event["notifyType"], NOTICE_TYPES) ?? "info", message: noticeMessage(text(event["message"]) ?? "") };
      return { ...state, notices: [...state.notices, notice].slice(-NOTICE_LIMIT) };
    }
    case "setStatus": {
      const key = text(event["statusKey"]);
      if (key === null) return state;
      const statusText = text(event["statusText"]);
      // Herdsman's status is a JSON snapshot, and the client draws agents rather than a string: the
      // raw text is parsed here and never reaches a browser
      if (key === HERDSMAN_KEY) {
        const herdsman = herdsmanOf(statusText);
        return herdsman === undefined || herdsman === state.herdsman ? state : { ...state, herdsman };
      }
      const statuses = { ...state.statuses };
      if (statusText === null) delete statuses[key];
      else statuses[key] = statusText;
      return { ...state, statuses };
    }
    case "setWidget": {
      const key = text(event["widgetKey"]);
      const lines = stringList(event["widgetLines"]);
      if (key === null) return state;
      const widgets = { ...state.widgets };
      if (lines.length === 0) delete widgets[key];
      else {
        widgets[key] = { lines: lines.slice(0, WIDGET_LINES).map((line) => line.slice(0, WIDGET_LINE_CHARS)), placement: oneOf(event["widgetPlacement"], WIDGET_PLACEMENTS) ?? "aboveEditor" };
        // a record keeps its insertion order, so the keys past the cap are the oldest
        const keys = Object.keys(widgets);
        for (const oldest of keys.slice(0, Math.max(0, keys.length - WIDGET_LIMIT))) delete widgets[oldest];
      }
      return { ...state, widgets };
    }
    case "set_editor_text": return { ...state, editorText: text(event["text"]) };
    /** `setTitle` names a terminal's tab, which a browser does itself */
    default: return state;
  }
}

function reduceMessageEnd(state: PiNativeState, event: PiRpcRecord): PiNativeState {
  const stats = state.stats;
  if (stats === null) return state;
  const message = object(event["message"]);
  const counted = { ...stats, totalMessages: stats.totalMessages + 1 };
  switch (text(message["role"])) {
    case "user": return { ...state, stats: { ...counted, userMessages: stats.userMessages + 1 } };
    case "assistant": return { ...state, stats: plusUsage({ ...counted, assistantMessages: stats.assistantMessages + 1 }, object(message["usage"])) };
    default: return state;
  }
}

function reduceCompactionEnd(state: PiNativeState, event: PiRpcRecord): PiNativeState {
  const failure = text(event["errorMessage"]);
  const next = { ...state, isCompacting: false };
  if (failure === null) return next;
  const notice: PiNativeNotice = { id: nextNoticeId(), type: "error", message: noticeMessage(`Compaction failed: ${failure}`) };
  return { ...next, notices: [...state.notices, notice].slice(-NOTICE_LIMIT) };
}

function reduceRetryEnd(state: PiNativeState, event: PiRpcRecord): PiNativeState {
  const failure = text(event["finalError"]);
  const next = { ...state, retry: null };
  if (event["success"] === true || failure === null) return next;
  const notice: PiNativeNotice = { id: nextNoticeId(), type: "error", message: noticeMessage(`Retries failed: ${failure}`) };
  return { ...next, notices: [...state.notices, notice].slice(-NOTICE_LIMIT) };
}

function reduceToolUpdate(state: PiNativeState, event: PiRpcRecord): PiNativeState {
  const id = text(event["toolCallId"]);
  if (id === null) return state;
  const content = object(event["partialResult"])["content"];
  const output = Array.isArray(content) ? content.map((block) => text(object(block)["text"]) ?? "").join("") : "";
  return { ...state, toolTails: { ...state.toolTails, [id]: tailOf(output) } };
}

/** A direct `bash` command's output arrives as deltas, keyed by its own command id; they extend its tail. */
function appendBashOutput(state: PiNativeState, event: PiRpcRecord): PiNativeState {
  const id = text(event["id"]);
  const delta = text(event["delta"]);
  if (id === null || delta === null) return state;
  return { ...state, toolTails: { ...state.toolTails, [id]: tailOf(`${(state.toolTails[id] ?? []).join("\n")}${delta}`) } };
}

function dropTail(state: PiNativeState, id: string | null): PiNativeState {
  if (id === null || state.toolTails[id] === undefined) return state;
  const toolTails = { ...state.toolTails };
  delete toolTails[id];
  return { ...state, toolTails };
}

/**
 * One RPC child and the state its records reduce to. Commands are answered out of order (pi's
 * handlers are async), so a call is matched by its own generated id and never by arrival.
 */
export class PiRpc {
  readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private current = initialPiNativeState();
  private readonly pending = new Map<string, { request: PiRpcRecord; resolve: (data: unknown) => void; reject: (error: Error) => void }>();
  private readonly stateListeners = new Set<(state: PiNativeState) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();
  private readonly log: (line: string) => void;
  /** the bytes of a record still waiting for its LF */
  private chunks: Uint8Array[] = [];
  private sequence = 0;
  private ending = false;
  /** the child is gone and its last records were read: nothing that arrives after this counts */
  private gone = false;
  /** the whole exit: the child ended and its pipes were drained */
  private readonly settled: Promise<void>;

  constructor(options: PiRpcOptions) {
    this.log = options.log ?? ((line) => console.error(`[pi-rpc] ${line}`));
    const argv = [...(options.bin ?? ["pi"]), "--mode", "rpc", "--session", options.sessionFile, ...(options.args ?? [])];
    this.child = Bun.spawn(argv, { cwd: options.cwd, env: options.env, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
    // the exit is handled only once the pipes are drained: a response written just before the child
    // left is still in them, and rejecting its caller would lose an answer pi already gave
    const output = this.pump(this.child.stdout);
    const errors = this.pumpErrors(this.child.stderr);
    this.settled = this.child.exited.then(async (code) => {
      await output;
      await errors;
      this.exited(code);
    });
  }

  get state(): PiNativeState { return this.current; }

  /** Every change of the reduced state. Returns the unsubscribe. */
  onState(listener: (state: PiNativeState) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  /** The child ending, with the code pi exited on (null when it was killed by a signal). */
  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  /**
   * Send one command and wait for its own response, which resolves with the response's `data`. A
   * refused command rejects with pi's `error`. A prompt's answer only means it was taken (see
   * `data.disposition`): the run ends at `agent_settled`, and the state says when it does.
   *
   * A command may bring its own id (`bash`: pi streams a command's output under it, and the chat that
   * ran one draws its own lines by the name it chose). An id another command still waits on is not
   * taken again: that call gets a generated one, and its caller simply finds no lines of its own.
   * Generated ids skip every id still pending, so no caller's answer is ever lost to another's.
   */
  call(command: PiRpcRecord & { type: string }): Promise<unknown> {
    if (this.ending) return Promise.reject(new Error("pi has exited"));
    const named = typeof command.id === "string" ? command.id : null;
    let id = named ?? "";
    if (named === null || this.pending.has(named)) {
      do { id = `req-${++this.sequence}`; } while (this.pending.has(id));
    }
    return new Promise((resolve, reject) => {
      // the command as it went out, its id included: the response reports what that command answered
      const sent = { ...command, id };
      this.pending.set(id, { request: sent, resolve, reject });
      // a command pi cannot be given is not a command that will ever be answered
      if (this.write(sent)) return;
      this.pending.delete(id);
      reject(new Error(`could not send ${command.type} to pi`));
    });
  }

  /**
   * Answer the dialog pi waits on. It sends no response to this, so nothing is awaited. False: the
   * child is gone and the answer went nowhere, so the dialog still waits (if pi is still there).
   */
  respond(id: string, answer: PiNativeUiAnswer): boolean {
    if (!this.write({ type: "extension_ui_response", id, ...answer })) return false;
    this.apply({ type: "ui_answered", id });
    return true;
  }

  /**
   * An orderly shutdown: pi disposes its runtime on stdin EOF. A child still there after the grace
   * is killed, so a stuck runtime cannot keep a pane's session file held.
   */
  async close(): Promise<void> {
    this.ending = true;
    try { this.child.stdin.end(); } catch { /* the child is already gone */ }
    const grace = setTimeout(() => { this.child.kill(); }, CLOSE_GRACE_MS);
    try { await this.child.exited; } finally { clearTimeout(grace); }
    // the state is `lost` by the time this answers, not a tick after it
    await this.settled;
  }

  private write(record: PiRpcRecord): boolean {
    if (this.gone) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(record)}\n`);
      const flushed: unknown = this.child.stdin.flush();
      if (flushed instanceof Promise) void flushed.catch((error: unknown) => this.log(`stdin: ${describe(error)}`));
      return true;
    } catch (error) { this.log(`stdin: ${describe(error)}`); return false; }
  }

  /** Read stdout as bytes, split on LF only (U+2028 is a character inside a record, not its end). */
  private async pump(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) this.push(value);
      }
    } catch (error) { this.log(`stdout: ${describe(error)}`); }
    // a last record the child ended without a newline still counts
    if (this.chunks.length > 0) { const rest = joinBytes(this.chunks); this.chunks = []; this.recordBytes(rest); }
  }

  /** Bytes in, whole records out: only the new chunk is scanned, and a record split over two is joined. */
  private push(chunk: Uint8Array): void {
    let start = 0;
    for (let at = 0; at < chunk.length; at += 1) {
      if (chunk[at] !== 0x0a) continue;
      const parts = chunk.subarray(start, at);
      const whole = this.chunks.length === 0 ? parts : joinBytes([...this.chunks, parts]);
      this.chunks = [];
      this.recordBytes(whole);
      start = at + 1;
    }
    if (start < chunk.length) this.chunks.push(chunk.subarray(start));
  }

  /** A record's bytes, without the CR of CRLF framing: LF is the only record end. */
  private recordBytes(bytes: Uint8Array): void {
    const ended = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d;
    this.record(utf8.decode(ended ? bytes.subarray(0, bytes.length - 1) : bytes));
  }

  private record(line: string): void {
    if (line.trim() === "") return;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { this.log(`unparsable record: ${line.slice(0, 200)}`); return; }
    const event = object(parsed);
    if (text(event["type"]) === "response") this.response(event);
    else this.apply(event);
  }

  private response(event: PiRpcRecord): void {
    const id = text(event["id"]);
    const pending = id === null ? undefined : this.pending.get(id);
    if (pending === undefined || id === null) {
      // pi answers a malformed command with `command: "parse"` and no id of ours: nothing waits on it
      this.log(`unsolicited response: ${text(event["command"]) ?? "?"}: ${text(event["error"]) ?? "ok"}`);
      return;
    }
    this.pending.delete(id);
    this.apply({ ...event, request: pending.request });
    if (event["success"] === true) pending.resolve(event["data"]);
    else pending.reject(new Error(text(event["error"]) ?? `pi refused ${text(pending.request["type"]) ?? "the command"}`));
  }

  /** stderr is diagnostics, never protocol: logged line by line, cut, so a chatty child cannot fill memory. */
  private async pumpErrors(stderr: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stderr.getReader();
    let carry = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        carry += utf8.decode(value, { stream: true });
        let at = carry.indexOf("\n");
        while (at >= 0) {
          this.log(`stderr: ${carry.slice(0, at).slice(0, STDERR_LINE_CHARS)}`);
          carry = carry.slice(at + 1);
          at = carry.indexOf("\n");
        }
        if (carry.length > STDERR_LINE_CHARS) carry = carry.slice(-STDERR_LINE_CHARS);
      }
    } catch (error) { this.log(`stderr: ${describe(error)}`); }
    if (carry !== "") this.log(`stderr: ${carry.slice(0, STDERR_LINE_CHARS)}`);
  }

  private apply(event: PiRpcRecord): void {
    // once the child is gone its state is final: a record that arrives late cannot make it live again
    if (this.gone) return;
    const next = reducePiEvent(this.current, event);
    if (next === this.current) return;
    this.current = next;
    for (const listener of this.stateListeners) {
      try { listener(next); } catch (error) { this.log(`state listener: ${describe(error)}`); }
    }
  }

  private exited(code: number | null): void {
    if (this.gone) return;
    this.ending = true;
    const error = new Error(`pi exited (${code ?? "signal"})`);
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.apply({ type: "exit" });
    this.gone = true;
    for (const listener of this.exitListeners) {
      try { listener(code); } catch (thrown) { this.log(`exit listener: ${describe(thrown)}`); }
    }
  }
}
