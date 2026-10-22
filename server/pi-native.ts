/**
 * The Pi panes this bridge drives itself: one `pi --mode rpc` child per native pane, the session
 * file it holds, the folder it runs in, and whether it is still up.
 *
 * A pane becomes native only by taking it over: pi's TUI in the pane quits, and the child starts on
 * the same session file, so no two writers ever hold it. Handing it back closes the child first and
 * starts the TUI again. The map is kept in the state directory, so a bridge restart brings the
 * panes back as `lost` for Reconnect instead of forgetting them.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PiNativeState } from "../shared/protocol.ts";
import { herdrSocketPath, paneSendKeys, paneSendText } from "./herdr/client.ts";
import { paneContext } from "./pane-context.ts";
import { piAgentDir } from "./pi-models.ts";
import { isPiProcess, paneRunsPi, piTranscriptPath } from "./pi.ts";
import { initialPiNativeState, PiRpc, type PiRpcOptions } from "./pi-rpc.ts";
import { shellAgentExecutable, startShellAgent } from "./shell-agent.ts";
import { readStateDocument, type StateDocument, writeStateDocument } from "./state-document.ts";

/** The Pi child's surface the registry uses; `PiRpc` is one, and tests put a fake one here. */
export interface PiNativeChild {
  readonly state: PiNativeState;
  call(command: { type: string } & Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  onState(listener: (state: PiNativeState) => void): () => void;
  onExit(listener: (code: number | null) => void): () => void;
}

/** A pane without a child (read from disk after a restart) is `lost` until Reconnect. */
export type PiNativeMode = PiNativeState["mode"];

/** One native pane: what it reads and writes, where, and the child (null before Reconnect). */
export interface PiNativePane {
  readonly paneId: string;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly rpc: PiNativeChild | null;
  readonly mode: PiNativeMode;
  readonly state: PiNativeState;
}

/** The one-time project-trust choice a take-over carries; Pi's RPC mode cannot ask by itself. */
export type PiTrust = "approve" | "deny";

/** A refusal the routes answer with its own status. */
export class PiNativeError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

/** Protected project resources with no saved decision: the client shows the trust card, then asks again. */
export class PiNeedsTrustError extends Error {
  constructor(readonly folder: string, readonly found: string[]) {
    super("Pi needs a project trust decision for this folder");
  }
}

/** What a route needs of the registry; tests put a fake here. */
export interface PiNativeControl {
  state(paneId: string): PiNativeState | null;
  /** the session file the pane's child writes, written or still to come; null for a pane it does not drive */
  sessionFile(paneId: string): string | null;
  /** one command over the pane's child, answered with Pi's `data` or the refusal it threw */
  call(paneId: string, command: { type: string } & Record<string, unknown>): Promise<unknown>;
  /** every change a native pane's state makes, by pane id; returns the unsubscribe */
  onState(listener: (paneId: string, state: PiNativeState) => void): () => void;
  takeover(paneId: string, options?: { trust?: PiTrust }): Promise<PiNativeState>;
  handBack(paneId: string): Promise<void>;
  reconnect(paneId: string): Promise<PiNativeState>;
  prune(livePaneIds: readonly string[]): void;
}

export interface PiNativeOptions {
  /** the bridge's state directory; the pane map is `pi-native.json` beside the other stores */
  stateDir: string;
  /** the pane as herdr has it now; tests replace it */
  pane?: (paneId: string) => Promise<{ agent: string | null; cwd: string; status: string }>;
  /** the session file pi in this pane holds, written or still to come; null when it cannot be read */
  transcript?: (paneId: string) => Promise<{ path: string } | { unwritten: { path: string } } | null>;
  /** whether the pane still runs pi in front; tests replace it */
  runsPi?: (paneId: string) => Promise<boolean>;
  /** type `/quit` into the pane's pi; tests replace it */
  quitTui?: (paneId: string) => Promise<void>;
  /** start pi's TUI on `sessionFile` in the pane; tests replace it */
  startTui?: (paneId: string, sessionFile: string) => Promise<void>;
  /** the RPC child; tests replace it */
  spawn?: (options: PiRpcOptions) => PiNativeChild;
  /** the child's environment: herdr's socket and pane id keep its sidebar and Herdsman working */
  env?: (paneId: string) => Record<string, string | undefined>;
  /** pi's agent directory, for trust.json; tests put one in a temp folder */
  agentDir?: string;
  /** how long a quit and a start may take, and how often they are checked */
  pollMs?: number;
  quitTimeoutMs?: number;
  log?: (line: string) => void;
}

/** The project resources pi protects (docs/security.md, `project trust`). `.agents/skills` is looked for upward. */
const PROJECT_RESOURCES = [".pi/settings.json", ".pi/mcp.json", ".pi/extensions", ".pi/skills", ".pi/prompts", ".pi/themes", ".pi/SYSTEM.md", ".pi/APPEND_SYSTEM.md"] as const;
const AGENTS_SKILLS = [".agents", "skills"] as const;
const PANE_MAP_FILE = "pi-native.json";
const DEFAULT_POLL_MS = 200;
const DEFAULT_QUIT_TIMEOUT_MS = 10_000;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The canonical path pi saves a trust decision under; an unresolvable one is used as given. */
function canonical(folder: string): string {
  try { return realpathSync(folder); } catch { return resolve(folder); }
}

/** The protected resources this folder carries, as paths relative to it (docs/security.md). */
export function projectResources(folder: string): string[] {
  const found: string[] = PROJECT_RESOURCES.filter((resource) => existsSync(join(folder, resource)));
  // project skills count in the folder and in an ancestor, so one above it still needs the decision
  for (let dir = folder; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ...AGENTS_SKILLS))) { found.push(AGENTS_SKILLS.join("/")); break; }
    if (dirname(dir) === dir) break;
  }
  return found;
}

/** Whether pi has a saved decision for this folder or one of its parents; either answer counts. */
export function trustDecided(folder: string, trustFile: string): boolean {
  let trust: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(trustFile, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    trust = parsed as Record<string, unknown>;
  } catch { return false; }
  for (let dir = canonical(folder); ; dir = dirname(dir)) {
    if (Object.hasOwn(trust, dir)) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** The one-time trust answer as pi's CLI flag; a saved decision or the global default needs none. */
const trustArgs = (trust: PiTrust | undefined): string[] => trust === undefined ? [] : [trust === "approve" ? "--approve" : "--no-approve"];

/** The user's `defaultProjectTrust`; `always` loads the resources, so no card is needed for them. */
function defaultProjectTrust(agentDir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const value = (parsed as Record<string, unknown>)["defaultProjectTrust"];
    return typeof value === "string" ? value : null;
  } catch { return null; }
}

/**
 * Pi's own exit command, after its clear-editor key: `ctrl+c` clears the draft (first press) before
 * `/quit` is typed, so a half-written draft is never joined by it and submitted to the model.
 */
async function quitPiTui(paneId: string): Promise<void> {
  await paneSendKeys(paneId, ["ctrl+c"]);
  await paneSendText(paneId, "/quit");
  await paneSendKeys(paneId, ["Enter"]);
}

/** The pane's shell runs pi's TUI on the session the chat wrote. */
async function startPiTui(paneId: string, sessionFile: string): Promise<void> {
  const executable = shellAgentExecutable("pi");
  if (executable === null) throw new Error("pi is not on this server's PATH");
  await startShellAgent("pi", paneId, ["--session", sessionFile], { command: executable, isProcess: isPiProcess });
}

/** What a stored entry is, checked row by row: anything else is dropped and the file kept aside. */
function storedPane(value: unknown): { pane_id: string; session: string; cwd: string; trust?: PiTrust } | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const { pane_id, session, cwd } = row;
  if (typeof pane_id !== "string" || pane_id === "" || typeof session !== "string" || session === "" || typeof cwd !== "string" || cwd === "") return null;
  const trust = row["trust"] === "approve" || row["trust"] === "deny" ? row["trust"] : undefined;
  return { pane_id, session, cwd, ...(trust === undefined ? {} : { trust }) };
}

class Entry implements PiNativePane {
  constructor(
    readonly paneId: string,
    readonly sessionFile: string,
    readonly cwd: string,
    readonly trust: PiTrust | undefined,
    readonly rpc: PiNativeChild | null,
  ) {}

  /** the flags this child started with, kept so a reconnect after a restart repeats the trust answer */
  get args(): string[] { return trustArgs(this.trust); }

  get mode(): PiNativeMode { return this.rpc === null ? "lost" : this.rpc.state.mode; }

  get state(): PiNativeState {
    return this.rpc === null ? { ...initialPiNativeState(), mode: "lost", sessionFile: this.sessionFile } : this.rpc.state;
  }
}

/**
 * One registry for the server's lifetime. Every operation on a pane is serialised with the others on
 * that pane, so two take-overs racing for one pane cannot both quit the TUI and spawn a child.
 */
export class PiNativeRegistry implements PiNativeControl {
  private readonly panes = new Map<string, Entry>();
  private readonly listeners = new Set<(paneId: string, state: PiNativeState) => void>();
  /** one trailing promise per pane: the next operation waits for the one before it */
  private readonly locks = new Map<string, Promise<void>>();
  private readonly stateDir: string;
  private readonly spawn: (options: PiRpcOptions) => PiNativeChild;
  private readonly pane: (paneId: string) => Promise<{ agent: string | null; cwd: string; status: string }>;
  private readonly transcript: (paneId: string) => Promise<{ path: string } | { unwritten: { path: string } } | null>;
  private readonly runsPi: (paneId: string) => Promise<boolean>;
  private readonly quitTui: (paneId: string) => Promise<void>;
  private readonly startTui: (paneId: string, sessionFile: string) => Promise<void>;
  private readonly env: (paneId: string) => Record<string, string | undefined>;
  private readonly agentDir: string;
  private readonly pollMs: number;
  private readonly quitTimeoutMs: number;
  private readonly log: (line: string) => void;
  /** the file on disk was not a pane map: the next save keeps it aside instead of dropping it */
  private damaged = false;

  constructor(options: PiNativeOptions) {
    this.stateDir = options.stateDir;
    this.spawn = options.spawn ?? ((spawnOptions) => new PiRpc(spawnOptions));
    this.pane = options.pane ?? (async (paneId) => {
      const context = await paneContext(paneId);
      return { agent: context.agent, cwd: context.cwd, status: context.pane.agent_status };
    });
    this.transcript = options.transcript ?? piTranscriptPath;
    this.runsPi = options.runsPi ?? paneRunsPi;
    this.quitTui = options.quitTui ?? quitPiTui;
    this.startTui = options.startTui ?? startPiTui;
    this.env = options.env ?? ((paneId) => ({ ...process.env, HERDR_ENV: "1", HERDR_SOCKET_PATH: herdrSocketPath(), HERDR_PANE_ID: paneId }));
    this.agentDir = options.agentDir ?? piAgentDir();
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.quitTimeoutMs = options.quitTimeoutMs ?? DEFAULT_QUIT_TIMEOUT_MS;
    this.log = options.log ?? ((line) => console.error(`[pi-native] ${line}`));
    this.load();
  }

  private get mapPath(): string { return join(this.stateDir, PANE_MAP_FILE); }

  /** A native pane without touching herdr: the routes answer a lost one with its last state. */
  state(paneId: string): PiNativeState | null {
    return this.panes.get(paneId)?.state ?? null;
  }

  /** The pane for the transcript reader: even a lost one still names the session the chat reads. */
  paneOf(paneId: string): PiNativePane | null {
    return this.panes.get(paneId) ?? null;
  }

  /** The session file a native pane's child holds; a pane the chat does not drive has none. */
  sessionFile(paneId: string): string | null {
    return this.panes.get(paneId)?.sessionFile ?? null;
  }

  /** One command over the pane's child. A lost child has nothing to answer it, so typists reconnect first. */
  async call(paneId: string, command: { type: string } & Record<string, unknown>): Promise<unknown> {
    const entry = this.panes.get(paneId);
    if (entry === undefined) throw new PiNativeError("not_native", "this pane is not driven by the chat", 404);
    if (entry.rpc === null) throw new PiNativeError("not_connected", "pi in this pane is not connected; reconnect it first", 409);
    return await entry.rpc.call(command);
  }

  /** Every change any native pane's state makes, by pane id. Returns the unsubscribe. */
  onState(listener: (paneId: string, state: PiNativeState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Forget panes herdr no longer lists, so a stale map cannot grow without a pane to show it in. */
  prune(livePaneIds: readonly string[]): void {
    const live = new Set(livePaneIds);
    // a pane pruned while start() awaits leaves its child without an entry to close (rare: a pane vanishing mid-take-over)
    let changed = false;
    for (const [paneId, entry] of [...this.panes]) {
      if (live.has(paneId)) continue;
      if (entry.rpc !== null) void entry.rpc.close().catch((error: unknown) => this.log(`closing ${paneId}: ${describe(error)}`));
      this.panes.delete(paneId);
      changed = true;
    }
    if (changed) this.save();
  }

  async takeover(paneId: string, options: { trust?: PiTrust } = {}): Promise<PiNativeState> {
    return this.serialized(paneId, async () => {
      if (this.panes.has(paneId)) {
        throw new PiNativeError("already_native", "this pane is already driven by the chat", 409);
      }
      const pane = await this.pane(paneId);
      if (pane.agent !== "pi") throw new PiNativeError("not_pi", "this pane is not running pi", 409);
      if (pane.status !== "idle") throw new PiNativeError("pane_busy", `pi in this pane is ${pane.status}; wait until it is idle`, 409);
      const transcript = await this.transcript(paneId);
      if (transcript === null) throw new PiNativeError("no_session", "this pane's pi session is not on a store this bridge can read", 409);
      const sessionFile = "path" in transcript ? transcript.path : transcript.unwritten.path;
      // the trust card answers with a one-time decision; without one, protected resources are asked about here
      if (options.trust === undefined) {
        const folder = canonical(pane.cwd);
        const found = projectResources(folder);
        // `always` loads them anyway, so asking would be a card with nothing behind it
        if (found.length > 0 && defaultProjectTrust(this.agentDir) !== "always" && !trustDecided(folder, join(this.agentDir, "trust.json"))) {
          throw new PiNeedsTrustError(folder, found);
        }
      }
      let quit = false;
      if (await this.runsPi(paneId)) {
        await this.quitTui(paneId);
        await this.waitForPiToLeave(paneId);
        quit = true;
      }
      try {
        return (await this.start(paneId, sessionFile, pane.cwd, options.trust, null)).state;
      } catch (error) {
        // the TUI already left: put it back rather than leave the pane at a bare shell
        if (quit) await this.startTui(paneId, sessionFile).catch((restore: unknown) => this.log(`restoring pi in ${paneId}: ${describe(restore)}`));
        throw error;
      }
    });
  }

  async handBack(paneId: string): Promise<void> {
    return this.serialized(paneId, async () => {
      const entry = this.panes.get(paneId);
      if (entry === undefined) throw new PiNativeError("not_native", "this pane is not driven by the chat", 404);
      if (entry.rpc !== null) {
        // a running turn is stopped before the child goes: nothing may write the session after it
        if (entry.rpc.state.isStreaming) await entry.rpc.call({ type: "abort" }).catch((error: unknown) => this.log(`abort before hand-back: ${describe(error)}`));
        await entry.rpc.close();
      }
      this.panes.delete(paneId);
      this.save();
      try { await this.startTui(paneId, entry.sessionFile); }
      catch (error) { throw new PiNativeError("handback_failed", `pi could not be started in the pane: ${describe(error)}`, 502); }
    });
  }

  async reconnect(paneId: string): Promise<PiNativeState> {
    return this.serialized(paneId, async () => {
      const entry = this.panes.get(paneId);
      if (entry === undefined) throw new PiNativeError("not_native", "this pane is not driven by the chat", 404);
      if (entry.mode !== "lost") throw new PiNativeError("not_lost", "pi in this pane is still connected", 409);
      return (await this.start(paneId, entry.sessionFile, entry.cwd, entry.trust, entry)).state;
    });
  }

  /** Close every child; the pane map stays, so the next bridge shows these panes as lost. */
  async close(): Promise<void> {
    const closing = [...this.panes.values()].flatMap((entry) => entry.rpc === null ? [] : [entry.rpc.close().catch((error: unknown) => this.log(`closing ${entry.paneId}: ${describe(error)}`))]);
    await Promise.all(closing);
  }

  /**
   * Spawn the child and seed it. `previous`, for a reconnect, is the lost entry that was there
   * before: a child that exits before answering restores it, so the pane stays reconnectable.
   */
  private async start(paneId: string, sessionFile: string, cwd: string, trust: PiTrust | undefined, previous: Entry | null): Promise<Entry> {
    let rpc: PiNativeChild;
    try {
      // a missing `pi`, a cwd that is gone or a refused spawn is an answer, not a crash after the TUI quit
      rpc = this.spawn({ sessionFile, cwd, args: trustArgs(trust), env: this.env(paneId) });
    } catch (error) {
      throw new PiNativeError("spawn_failed", `could not start pi: ${describe(error)}`, 502);
    }
    const entry = new Entry(paneId, sessionFile, cwd, trust, rpc);
    this.panes.set(paneId, entry);
    const mine = (): boolean => this.panes.get(paneId) === entry;
    rpc.onState((state) => { if (mine()) this.emit(paneId, state); });
    // a child that left on its own is lost, not gone: the session file is still there to reconnect to
    rpc.onExit(() => { if (mine()) this.emit(paneId, entry.state); });
    try {
      await rpc.call({ type: "get_state" });
      void rpc.call({ type: "get_session_stats" }).catch(() => undefined);
    } catch (error) {
      if (rpc.state.mode === "lost") {
        // a pane pruned while this waited is left pruned: the child it started is already gone
        if (this.panes.get(paneId) === entry) {
          if (previous === null) this.panes.delete(paneId);
          else this.panes.set(paneId, previous);
        }
        throw new PiNativeError("spawn_failed", `pi exited before answering: ${describe(error)}`, 502);
      }
      // a live child that refused one read is still a usable child
      this.log(`seeding ${paneId}: ${describe(error)}`);
    }
    this.save();
    return entry;
  }

  private async waitForPiToLeave(paneId: string): Promise<void> {
    const deadline = Date.now() + this.quitTimeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.runsPi(paneId))) return;
      await Bun.sleep(this.pollMs);
    }
    throw new PiNativeError("quit_timeout", "pi in this pane did not quit; close it in the terminal and try again", 409);
  }

  private serialized<T>(paneId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(paneId) ?? Promise.resolve();
    const result = previous.then(work);
    const tail = result.then(() => undefined, () => undefined);
    this.locks.set(paneId, tail);
    void tail.then(() => { if (this.locks.get(paneId) === tail) this.locks.delete(paneId); });
    return result;
  }

  private emit(paneId: string, state: PiNativeState): void {
    for (const listener of this.listeners) {
      try { listener(paneId, state); } catch (error) { this.log(`state listener: ${describe(error)}`); }
    }
  }

  private load(): void {
    // entries are matched by pane id alone, and herdr can reuse an id after a restart; a stale entry
    // can light up another pane until a /api/pi request prunes it
    let read: StateDocument;
    try { read = readStateDocument(this.mapPath); }
    catch (error) { this.log(`cannot read ${this.mapPath}: ${describe(error)}; native panes start empty`); return; }
    if (read.kind === "missing") return;
    const rows = read.kind === "json" && Array.isArray(read.value) ? read.value : null;
    if (rows === null) {
      this.damaged = true;
      this.log(`${this.mapPath} is not a pane map; the next change keeps it aside`);
      return;
    }
    for (const row of rows) {
      const pane = storedPane(row);
      if (pane === null) { this.damaged = true; continue; }
      this.panes.set(pane.pane_id, new Entry(pane.pane_id, pane.session, pane.cwd, pane.trust, null));
    }
  }

  private save(): void {
    const panes = [...this.panes.values()].map((entry) => ({
      pane_id: entry.paneId,
      session: entry.sessionFile,
      cwd: entry.cwd,
      ...(entry.trust === undefined ? {} : { trust: entry.trust }),
    }));
    try {
      writeStateDocument(this.mapPath, `${JSON.stringify(panes, null, 2)}\n`, this.damaged);
      this.damaged = false;
    } catch (error) {
      this.log(`cannot save ${this.mapPath}: ${describe(error)}`);
    }
  }
}
