import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiNativeState } from "../shared/protocol.ts";
import { initialPiNativeState } from "./pi-rpc.ts";
import type { PiRpcOptions } from "./pi-rpc.ts";
import { PiNativeError, PiNativeRegistry, PiNeedsTrustError, type PiNativeChild, type PiNativeOptions } from "./pi-native.ts";

// A registry with a fake pi on the other end and fake herdr answers: the state machine is the
// subject, so no child process, socket or real state directory is needed.
class FakeChild implements PiNativeChild {
  state: PiNativeState;
  readonly calls: { type: string }[] = [];
  closed = false;
  /** a child that leaves instead of answering the first get_state */
  exitOnGetState = false;
  private readonly stateListeners = new Set<(state: PiNativeState) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();

  constructor(private readonly sessionFile: string) {
    this.state = { ...initialPiNativeState(), sessionFile };
  }

  async call(command: { type: string } & Record<string, unknown>): Promise<unknown> {
    this.calls.push(command);
    if (command.type === "get_state") {
      if (this.exitOnGetState) {
        this.exit();
        throw new Error("pi exited (0)");
      }
      this.state = { ...initialPiNativeState(), mode: "native", sessionFile: this.sessionFile };
      this.notify();
    }
    return {};
  }

  respond(): void {}

  close(): Promise<void> { this.closed = true; return Promise.resolve(); }

  onState(listener: (state: PiNativeState) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  stream(): void {
    this.state = { ...this.state, isStreaming: true };
    this.notify();
  }

  /** a session move (switch_session, new_session, fork, clone): the child holds another file from now on */
  move(sessionFile: string): void {
    this.state = { ...this.state, sessionFile };
    this.notify();
  }

  /** the child leaving on its own: not requested through hand-back */
  exit(code = 0): void {
    this.state = { ...this.state, mode: "lost" };
    this.notify();
    for (const listener of this.exitListeners) listener(code);
  }

  private notify(): void {
    for (const listener of this.stateListeners) listener(this.state);
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  root: string;
  project: string;
  sessionFile: string;
  agentDir: string;
  registry: PiNativeRegistry;
  options: PiNativeOptions;
  children: FakeChild[];
  spawned: PiRpcOptions[];
  calls: string[];
  /** the next child leaves instead of answering get_state */
  failNextGetState: { current: boolean };
}

/** A new registry over a temp folder; `pane` and any other dependency can be replaced per test. */
function setup(overrides: Partial<PiNativeOptions> = {}, pane: { agent?: string; status?: string } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "ovis-pi-native-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const sessionFile = join(root, "session.jsonl");
  const agentDir = join(root, "agent");
  const children: FakeChild[] = [];
  const spawned: PiRpcOptions[] = [];
  const calls: string[] = [];
  const failNextGetState = { current: false };
  const options: PiNativeOptions = {
    stateDir: join(root, "state"),
    pane: async () => ({ agent: pane.agent ?? "pi", cwd: project, status: pane.status ?? "idle" }),
    transcript: async () => ({ path: sessionFile }),
    runsPi: async () => false,
    quitTui: async (paneId) => { calls.push(`quit:${paneId}`); },
    startTui: async (paneId, file) => { calls.push(`start:${paneId}:${file}`); },
    spawn: (spawnOptions) => {
      spawned.push(spawnOptions);
      const child = new FakeChild(spawnOptions.sessionFile);
      child.exitOnGetState = failNextGetState.current;
      failNextGetState.current = false;
      children.push(child);
      return child;
    },
    env: () => ({}),
    agentDir,
    pollMs: 1,
    quitTimeoutMs: 300,
    log: () => undefined,
    ...overrides,
  };
  return { root, project, sessionFile, agentDir, registry: new PiNativeRegistry(options), options, children, spawned, calls, failNextGetState };
}

describe("PiNativeRegistry take-over", () => {
  it("refuses a pane whose pi is not idle, without touching its terminal", async () => {
    const h = setup({}, { status: "working" });
    await expect(h.registry.takeover("w:p1")).rejects.toMatchObject({ code: "pane_busy", status: 409 });
    expect(h.spawned).toHaveLength(0);
    expect(h.calls).toEqual([]);
  });

  it("refuses a pane that does not run pi", async () => {
    const h = setup({}, { agent: "claude" });
    await expect(h.registry.takeover("w:p1")).rejects.toMatchObject({ code: "not_pi" });
    expect(h.spawned).toHaveLength(0);
  });

  it("asks for a trust decision before quitting a TUI that runs protected project resources", async () => {
    const h = setup();
    mkdirSync(join(h.project, ".pi", "extensions"), { recursive: true });
    const error = await h.registry.takeover("w:p1").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PiNeedsTrustError);
    expect((error as PiNeedsTrustError).folder).toBe(realpathSync(h.project));
    expect((error as PiNeedsTrustError).found).toContain(".pi/extensions");
    // the TUI stays as it was and no child starts
    expect(h.calls).toEqual([]);
    expect(h.spawned).toHaveLength(0);
  });

  it("takes a saved decision for a parent folder as the answer", async () => {
    const h = setup();
    mkdirSync(join(h.project, ".pi"), { recursive: true });
    writeFileSync(join(h.project, ".pi", "settings.json"), "{}\n");
    mkdirSync(h.agentDir, { recursive: true });
    writeFileSync(join(h.agentDir, "trust.json"), JSON.stringify({ [realpathSync(h.root)]: true }));
    await expect(h.registry.takeover("w:p1")).resolves.toMatchObject({ mode: "native" });
    expect(h.spawned).toHaveLength(1);
  });

  it("skips the trust card when the user's default is to always load project resources", async () => {
    const h = setup();
    mkdirSync(join(h.project, ".pi"), { recursive: true });
    writeFileSync(join(h.project, ".pi", "settings.json"), "{}\n");
    mkdirSync(h.agentDir, { recursive: true });
    writeFileSync(join(h.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
    await expect(h.registry.takeover("w:p1")).resolves.toMatchObject({ mode: "native" });
    expect(h.spawned[0]?.args).toEqual([]);
  });

  it("passes the trust answer as pi's one-time approval flag", async () => {
    const h = setup();
    mkdirSync(join(h.project, ".pi"), { recursive: true });
    writeFileSync(join(h.project, ".pi", "settings.json"), "{}\n");
    await h.registry.takeover("w:p1", { trust: "approve" });
    await h.registry.takeover("w:p2", { trust: "deny" });
    expect(h.spawned.map((options) => options.args)).toEqual([["--approve"], ["--no-approve"]]);
  });

  it("quits the TUI, waits for pi to leave, then spawns on the pane's session file", async () => {
    let running = true;
    const h = setup({ runsPi: async () => { const seen = running; running = false; return seen; } });
    const state = await h.registry.takeover("w:p1");
    expect(h.calls).toEqual(["quit:w:p1"]);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]?.sessionFile).toBe(h.sessionFile);
    expect(h.spawned[0]?.cwd).toBe(h.project);
    expect(state.mode).toBe("native");
  });

  it("keeps the session directory override in the child's environment", async () => {
    const h = setup({ env: (paneId) => ({ ...process.env, PI_CODING_AGENT_SESSION_DIR: "/custom/store", HERDR_PANE_ID: paneId }) });
    await h.registry.takeover("w:p1");
    expect(h.spawned[0]?.env).toMatchObject({ PI_CODING_AGENT_SESSION_DIR: "/custom/store", HERDR_PANE_ID: "w:p1" });
  });

  it("fails when pi does not quit, and never starts a second writer", async () => {
    const h = setup({ runsPi: async () => true, quitTimeoutMs: 20 });
    await expect(h.registry.takeover("w:p1")).rejects.toMatchObject({ code: "quit_timeout" });
    expect(h.spawned).toHaveLength(0);
    expect(h.registry.state("w:p1")).toBeNull();
  });

  it("answers a spawn that throws instead of leaving a half-taken pane", async () => {
    const h = setup({ spawn: () => { throw new Error("no pi here"); } });
    await expect(h.registry.takeover("w:p1")).rejects.toMatchObject({ code: "spawn_failed" });
    expect(h.registry.state("w:p1")).toBeNull();
  });

  it("puts the TUI back when the child cannot start after the quit", async () => {
    let running = true;
    const h = setup({
      spawn: () => { throw new Error("no pi here"); },
      runsPi: async () => { const seen = running; running = false; return seen; },
    });
    await expect(h.registry.takeover("w:p1")).rejects.toMatchObject({ code: "spawn_failed" });
    expect(h.calls).toEqual(["quit:w:p1", `start:w:p1:${h.sessionFile}`]);
    expect(h.registry.state("w:p1")).toBeNull();
  });

  it("serialises two take-overs racing for one pane, so only one child starts", async () => {
    const h = setup();
    const outcomes = await Promise.allSettled([h.registry.takeover("w:p1"), h.registry.takeover("w:p1")]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
    expect((outcomes[1] as PromiseRejectedResult).reason).toMatchObject({ code: "already_native" });
    expect(h.spawned).toHaveLength(1);
  });
});

describe("PiNativeRegistry lost and hand-back", () => {
  it("marks a child that exits on its own lost, and keeps the session for Reconnect", async () => {
    const h = setup();
    await h.registry.takeover("w:p1");
    h.children[0]!.exit();
    expect(h.registry.paneOf("w:p1")?.mode).toBe("lost");
    expect(h.registry.state("w:p1")).toMatchObject({ mode: "lost", sessionFile: h.sessionFile });
    const saved = JSON.parse(readFileSync(join(h.root, "state", "pi-native.json"), "utf8")) as { pane_id: string }[];
    expect(saved.map((row) => row.pane_id)).toEqual(["w:p1"]);
    await expect(h.registry.reconnect("w:p1")).resolves.toMatchObject({ mode: "native" });
    expect(h.spawned[1]?.sessionFile).toBe(h.sessionFile);
  });

  it("reloads a saved pane as lost with its session file", async () => {
    const h = setup();
    await h.registry.takeover("w:p1");
    const reloaded = new PiNativeRegistry(h.options);
    expect(reloaded.state("w:p1")).toMatchObject({ mode: "lost", sessionFile: h.sessionFile, isStreaming: false });
    expect(reloaded.paneOf("w:p1")?.mode).toBe("lost");
  });

  it("keeps the trust answer for a reconnect after a restart", async () => {
    const h = setup();
    await h.registry.takeover("w:p1", { trust: "approve" });
    const reloaded = new PiNativeRegistry(h.options);
    await expect(reloaded.reconnect("w:p1")).resolves.toMatchObject({ mode: "native" });
    expect(h.spawned[1]?.args).toEqual(["--approve"]);
  });

  it("keeps a lost pane reconnectable when the new child exits before answering", async () => {
    const h = setup();
    await h.registry.takeover("w:p1");
    h.children[0]!.exit();
    h.failNextGetState.current = true;
    await expect(h.registry.reconnect("w:p1")).rejects.toMatchObject({ code: "spawn_failed" });
    expect(h.registry.paneOf("w:p1")?.mode).toBe("lost");
    expect(h.registry.state("w:p1")).toMatchObject({ mode: "lost", sessionFile: h.sessionFile });
    await expect(h.registry.reconnect("w:p1")).resolves.toMatchObject({ mode: "native" });
    expect(h.spawned).toHaveLength(3);
  });

  it("aborts a streaming turn, closes the child and starts pi's TUI on the session", async () => {
    const h = setup();
    await h.registry.takeover("w:p1");
    h.children[0]!.stream();
    await h.registry.handBack("w:p1");
    expect(h.children[0]!.calls.map((call) => call.type)).toEqual(["get_state", "get_session_stats", "abort"]);
    expect(h.children[0]!.closed).toBe(true);
    expect(h.calls).toEqual([`start:w:p1:${h.sessionFile}`]);
    expect(h.registry.state("w:p1")).toBeNull();
    const saved = JSON.parse(readFileSync(join(h.root, "state", "pi-native.json"), "utf8")) as unknown[];
    expect(saved).toEqual([]);
  });

  it("drops a pane herdr no longer lists", async () => {
    const h = setup();
    await h.registry.takeover("w:p1");
    h.registry.prune(["w:p2"]);
    expect(h.registry.state("w:p1")).toBeNull();
    expect(h.children[0]!.closed).toBe(true);
    const saved = JSON.parse(readFileSync(join(h.root, "state", "pi-native.json"), "utf8")) as unknown[];
    expect(saved).toEqual([]);
  });

  it("follows the session file the child moves to, for the transcript, a reconnect and a hand-back", async () => {
    const h = setup();
    await h.registry.takeover("w:p1");
    expect(h.registry.sessionFile("w:p1")).toBe(h.sessionFile);
    // `switch_session` is allowlisted: pi holds another file afterwards, and its own state says which
    const moved = join(h.root, "moved.jsonl");
    await h.registry.call("w:p1", { type: "switch_session", sessionPath: moved });
    h.children[0]!.move(moved);
    expect(h.registry.sessionFile("w:p1")).toBe(moved);
    // the map keeps it, so a bridge restart reconnects to the session pi actually holds
    const saved = JSON.parse(readFileSync(join(h.root, "state", "pi-native.json"), "utf8")) as { pane_id: string; session: string; cwd: string }[];
    expect(saved).toEqual([{ pane_id: "w:p1", session: moved, cwd: h.project }]);
    h.children[0]!.exit();
    await expect(h.registry.reconnect("w:p1")).resolves.toMatchObject({ mode: "native" });
    expect(h.spawned[1]?.sessionFile).toBe(moved);
    const again = join(h.root, "again.jsonl");
    h.children[1]!.move(again);
    await h.registry.handBack("w:p1");
    expect(h.calls).toEqual([`start:w:p1:${again}`]);
  });

  it("tells a watcher the last state of a pane it hands back or drops", async () => {
    const h = setup();
    const seen: { paneId: string; mode: string }[] = [];
    h.registry.onState((paneId, state) => seen.push({ paneId, mode: state.mode }));
    await h.registry.takeover("w:p1");
    await h.registry.handBack("w:p1");
    expect(seen.at(-1)).toEqual({ paneId: "w:p1", mode: "removed" });
    await h.registry.takeover("w:p1");
    seen.length = 0;
    h.registry.prune([]);
    expect(seen).toEqual([{ paneId: "w:p1", mode: "removed" }]);
  });

  it("refuses a hand-back for a pane it does not drive", async () => {
    const h = setup();
    await expect(h.registry.handBack("w:p1")).rejects.toBeInstanceOf(PiNativeError);
    expect(h.calls).toEqual([]);
  });
});
