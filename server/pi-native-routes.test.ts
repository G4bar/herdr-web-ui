import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import type { PiNativeState } from "../shared/protocol.ts";
import { initialPiNativeState } from "./pi-rpc.ts";
import { type PiNativeControl, PiNeedsTrustError, PiNativeError } from "./pi-native.ts";
import { handlePiNativeRequest } from "./pi-native-routes.ts";

// The routes' own checks: what a request may say, which pane it may name, and how a registry
// refusal becomes an HTTP answer. The registry is the fake, so no pane or child is touched.

const paneId = "w:p1";

function control(overrides: Partial<PiNativeControl> = {}): PiNativeControl {
  return {
    state: () => null,
    sessionFile: () => null,
    call: async () => ({}),
    respond: () => true,
    onState: () => () => undefined,
    takeover: async () => initialPiNativeState(),
    handBack: async () => undefined,
    reconnect: async () => initialPiNativeState(),
    prune: () => undefined,
    ...overrides,
  };
}

function call(
  pathAndQuery: string,
  init: RequestInit = {},
  registry: PiNativeControl = control(),
  panes: { pane_id: string }[] = [{ pane_id: paneId }],
  cwd?: string,
): Promise<Response | null> {
  const url = new URL(`http://ovis${pathAndQuery}`);
  return handlePiNativeRequest(new Request(url, init), url, url.pathname, {
    registry,
    snapshot: async () => ({ panes }),
    ...(cwd === undefined ? {} : { paneCwd: async () => cwd }),
  });
}

const post = (pathname: string, body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** Runs `run` against a temp agent directory, so Pi's own files are never read or written. */
async function withAgentDir(run: (dir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ovis-pi-agent-"));
  const before = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = root;
  try {
    await run(root);
  } finally {
    if (before === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = before;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("native Pi routes", () => {
  it("leaves other paths alone", async () => {
    expect(await call("/api/pi/other")).toBeNull();
  });

  it("requires a pane id and the route's own method", async () => {
    const missing = await call("/api/pi/takeover", post("/api/pi/takeover", {}));
    expect(missing?.status).toBe(400);
    expect(await missing?.json()).toMatchObject({ error: { code: "missing_pane_id" } });

    const stateWithoutId = await call("/api/pi/state");
    expect(stateWithoutId?.status).toBe(400);

    const wrongMethod = await call("/api/pi/takeover", { method: "GET" });
    expect(wrongMethod?.status).toBe(400);
    expect(await wrongMethod?.json()).toMatchObject({ error: { code: "method_not_allowed" } });
  });

  it("refuses a trust answer that is not approve or deny", async () => {
    const response = await call("/api/pi/takeover", post("/api/pi/takeover", { pane_id: paneId, trust: "maybe" }));
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: { code: "invalid_trust" } });
  });

  it("answers an unknown pane with 404 and drops it from the map", async () => {
    let pruned: readonly string[] = [];
    const registry = control({ prune: (live) => { pruned = live; } });
    const response = await call("/api/pi/state?pane_id=w:gone", {}, registry, [{ pane_id: "w:alive" }]);
    expect(response?.status).toBe(404);
    expect(await response?.json()).toMatchObject({ error: { code: "pane_not_found" } });
    expect(pruned).toEqual(["w:alive"]);
  });

  it("answers a pane the chat does not drive with 404", async () => {
    const response = await call(`/api/pi/state?pane_id=${paneId}`);
    expect(response?.status).toBe(404);
    expect(await response?.json()).toMatchObject({ error: { code: "not_native" } });
  });

  it("returns the registry's state with no-store", async () => {
    const state: PiNativeState = { ...initialPiNativeState(), mode: "native" };
    const response = await call(`/api/pi/state?pane_id=${paneId}`, {}, control({ state: () => state }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toMatchObject({ mode: "native" });
  });

  it("turns a missing trust decision into the 409 the trust card reads", async () => {
    const registry = control({ takeover: async () => { throw new PiNeedsTrustError("/work/project", [".pi/settings.json"]); } });
    const response = await call("/api/pi/takeover", post("/api/pi/takeover", { pane_id: paneId }), registry);
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      error: { code: "needs_trust", message: "Pi needs a project trust decision for this folder" },
      folder: "/work/project",
      found: [".pi/settings.json"],
    });
  });

  it("answers a registry refusal with its own code and status", async () => {
    const registry = control({ handBack: async () => { throw new PiNativeError("not_native", "this pane is not driven by the chat", 404); } });
    const response = await call("/api/pi/handback", post("/api/pi/handback", { pane_id: paneId }), registry);
    expect(response?.status).toBe(404);
    expect(await response?.json()).toMatchObject({ error: { code: "not_native" } });
  });

  it("passes the take-over's pane and trust answer to the registry", async () => {
    const seen: unknown[] = [];
    const registry = control({ takeover: async (id, options) => { seen.push([id, options]); return initialPiNativeState(); } });
    const response = await call("/api/pi/takeover", post("/api/pi/takeover", { pane_id: paneId, trust: "deny" }), registry);
    expect(response?.status).toBe(200);
    expect(seen).toEqual([[paneId, { trust: "deny" }]]);
  });

  it("hands a pane back and reconnects one", async () => {
    let handed = "";
    const registry = control({ handBack: async (id) => { handed = id; }, reconnect: async () => ({ ...initialPiNativeState(), mode: "native" }) });
    expect(await (await call("/api/pi/handback", post("/api/pi/handback", { pane_id: paneId }), registry))?.json()).toEqual({ ok: true });
    expect(handed).toBe(paneId);
    expect(await (await call("/api/pi/reconnect", post("/api/pi/reconnect", { pane_id: paneId }), registry))?.json()).toMatchObject({ mode: "native" });
  });
});

describe("native Pi context", () => {
  it("names the agent directory's file first, then the root's down to the pane's own folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-pi-context-"));
    const agentDir = join(root, "agent");
    const project = join(root, "work", "project");
    const before = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    try {
      for (const dir of [agentDir, join(root, "work"), project]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(agentDir, "AGENTS.md"), "global\n");
      // two names in one directory: Pi takes the override and leaves the other
      writeFileSync(join(root, "AGENTS.md"), "root\n");
      writeFileSync(join(root, "work", "CLAUDE.md"), "parent\n");
      writeFileSync(join(project, "AGENTS.override.md"), "override\n");
      writeFileSync(join(project, "AGENTS.md"), "shadowed\n");
      const response = await call(`/api/pi/context?pane_id=${paneId}`, {}, control(), [{ pane_id: paneId }], project);
      expect(response?.status).toBe(200);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      expect(await response?.json()).toEqual({
        files: [
          { path: join(agentDir, "AGENTS.md"), scope: "global", size: 7 },
          { path: join(root, "AGENTS.md"), scope: "parent", size: 5 },
          { path: join(root, "work", "CLAUDE.md"), scope: "parent", size: 7 },
          { path: join(project, "AGENTS.override.md"), scope: "project", size: 9 },
        ],
      });
    } finally {
      if (before === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = before;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("answers a folder with no context file, and a pane that is gone", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-pi-context-empty-"));
    const before = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
    try {
      const empty = await call(`/api/pi/context?pane_id=${paneId}`, {}, control(), [{ pane_id: paneId }], root);
      expect(await empty?.json()).toEqual({ files: [] });
      const gone = await call(`/api/pi/context?pane_id=w:gone`, {}, control(), [{ pane_id: paneId }], root);
      expect(gone?.status).toBe(404);
      const wrongMethod = await call(`/api/pi/context?pane_id=${paneId}`, post(`/api/pi/context`, { pane_id: paneId }), control(), [{ pane_id: paneId }], root);
      expect(wrongMethod?.status).toBe(400);
    } finally {
      if (before === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = before;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("native Pi keybindings", () => {
  it("answers Pi's own keys for a machine with no file, and says why", async () => {
    await withAgentDir(async (dir) => {
      const response = await call("/api/pi/keybindings");
      expect(response?.status).toBe(200);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      const answer = (await response?.json()) as { path: string; keys: Record<string, string[]>; warning?: string };
      expect(answer.path).toBe(join(dir, "keybindings.json"));
      expect(answer.keys).toEqual({
        "app.model.select": ["ctrl+l"],
        "app.model.cycleForward": ["ctrl+p"],
        "app.model.cycleBackward": ["shift+ctrl+p"],
        "app.thinking.cycle": ["shift+tab"],
        "app.thinking.toggle": ["ctrl+t"],
        "app.tools.expand": ["ctrl+o"],
        "app.message.followUp": ["alt+enter"],
        "app.message.dequeue": ["alt+up"],
      });
      expect(answer.warning).toContain("no such file");
    });
  });

  it("takes the file's own chords over the defaults, an empty list disabling one", async () => {
    await withAgentDir(async (dir) => {
      // Pi's document is flat, and a value is one chord or a list of them
      writeFileSync(join(dir, "keybindings.json"), JSON.stringify({
        "app.model.select": "ctrl+shift+m",
        "app.thinking.cycle": ["shift+tab", "f2"],
        "app.tools.expand": [],
        "tui.editor.cursorUp": "ctrl+u",
      }));
      const answer = (await (await call("/api/pi/keybindings"))?.json()) as { keys: Record<string, string[]>; warning?: string };
      expect(answer.warning).toBeUndefined();
      expect(answer.keys["app.model.select"]).toEqual(["ctrl+shift+m"]);
      expect(answer.keys["app.thinking.cycle"]).toEqual(["shift+tab", "f2"]);
      expect(answer.keys["app.tools.expand"]).toEqual([]);
      // a chord of another kind in a list is dropped, and an id the chat has no surface for is not ours
      expect(Object.keys(answer.keys).sort()).toEqual(["app.message.dequeue", "app.message.followUp", "app.model.cycleBackward", "app.model.cycleForward", "app.model.select", "app.thinking.cycle", "app.thinking.toggle", "app.tools.expand"]);
    });
  });

  it("keeps the defaults for a file that is not Pi's own, and refuses the wrong method", async () => {
    await withAgentDir(async (dir) => {
      writeFileSync(join(dir, "keybindings.json"), "[ not json");
      const unreadable = (await (await call("/api/pi/keybindings"))?.json()) as { keys: Record<string, string[]>; warning?: string };
      expect(unreadable.warning).toContain("not valid JSON");
      expect(unreadable.keys["app.model.select"]).toEqual(["ctrl+l"]);
      writeFileSync(join(dir, "keybindings.json"), "[\"ctrl+l\"]");
      expect(((await (await call("/api/pi/keybindings"))?.json()) as { warning?: string }).warning).toContain("not a JSON object");
      expect((await call("/api/pi/keybindings", post("/api/pi/keybindings", {})))?.status).toBe(400);
    });
  });
});

describe("native Pi settings", () => {
  const readSettings = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));

  it("answers only the keys the web may write, for a machine with or without a file", async () => {
    await withAgentDir(async (dir) => {
      const absent = await call("/api/pi/settings");
      expect(absent?.status).toBe(200);
      expect(absent?.headers.get("cache-control")).toBe("no-store");
      expect(await absent?.json()).toEqual({ path: join(dir, "settings.json"), settings: {} });

      writeFileSync(join(dir, "settings.json"), JSON.stringify({
        theme: "rose-pine",
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4.5",
        defaultThinkingLevel: "high",
        enabledModels: ["anthropic/claude-sonnet-4.5", 7],
      }));
      expect(await (await call("/api/pi/settings"))?.json()).toEqual({
        path: join(dir, "settings.json"),
        settings: {
          defaultProvider: "anthropic",
          defaultModel: "claude-sonnet-4.5",
          defaultThinkingLevel: "high",
          enabledModels: ["anthropic/claude-sonnet-4.5"],
        },
      });
    });
  });

  it("writes the keys it is given, keeps every other one, and leaves no temp file behind", async () => {
    await withAgentDir(async (dir) => {
      const kept = { theme: "rose-pine", packages: ["npm:pi-lens"], compaction: { modelOverrides: { "a/b": { reserveTokens: 5 } } }, defaultModel: "old-model" };
      writeFileSync(join(dir, "settings.json"), JSON.stringify(kept));
      const response = await call("/api/pi/settings", post("/api/pi/settings", { defaultThinkingLevel: "low", enabledModels: [] }));
      expect(response?.status).toBe(200);
      expect(readSettings(dir)).toEqual({ ...kept, defaultThinkingLevel: "low", enabledModels: [] });
      expect(await response?.json()).toMatchObject({ settings: { defaultModel: "old-model", defaultThinkingLevel: "low", enabledModels: [] } });
      // the new document arrives under a temp name that never outlives the write
      expect(readdirSync(dir)).toEqual(["settings.json"]);
    });
  });

  it("creates the file for an agent directory that has none", async () => {
    await withAgentDir(async (dir) => {
      const nested = join(dir, "nested");
      mkdirSync(nested);
      process.env["PI_CODING_AGENT_DIR"] = nested;
      const response = await call("/api/pi/settings", post("/api/pi/settings", { defaultModel: "gpt-5" }));
      expect(response?.status).toBe(200);
      expect(JSON.parse(readFileSync(join(nested, "settings.json"), "utf8"))).toEqual({ defaultModel: "gpt-5" });
    });
  });

  it("refuses an unknown key and a value pi would not accept, and writes nothing", async () => {
    await withAgentDir(async (dir) => {
      const path = join(dir, "settings.json");
      writeFileSync(path, JSON.stringify({ theme: "rose-pine" }));
      const refused: [Record<string, unknown>, string][] = [
        [{ theme: "dark" }, "unknown_setting"],
        [{ defaultModel: "" }, "invalid_setting"],
        [{ defaultProvider: "   " }, "invalid_setting"],
        [{ defaultThinkingLevel: "ultra" }, "invalid_setting"],
        [{ enabledModels: "anthropic/claude-sonnet-4.5" }, "invalid_setting"],
        [{ enabledModels: ["ok", 3] }, "invalid_setting"],
      ];
      for (const [body, code] of refused) {
        const response = await call("/api/pi/settings", post("/api/pi/settings", body));
        expect(response?.status).toBe(400);
        expect(await response?.json()).toMatchObject({ error: { code } });
      }
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "rose-pine" });
    });
  });

  it("refuses a file that is not valid JSON, on a read and on a write, and leaves it as it was", async () => {
    await withAgentDir(async (dir) => {
      const path = join(dir, "settings.json");
      writeFileSync(path, "{ not json");
      for (const init of [{}, post("/api/pi/settings", { defaultModel: "gpt-5" })]) {
        const response = await call("/api/pi/settings", init);
        expect(response?.status).toBe(409);
        expect(await response?.json()).toMatchObject({ error: { code: "invalid_settings_file" } });
      }
      expect(readFileSync(path, "utf8")).toBe("{ not json");
    });
  });

  it("answers an empty body and the wrong method", async () => {
    await withAgentDir(async (dir) => {
      const empty = await call("/api/pi/settings", post("/api/pi/settings", {}));
      expect(empty?.status).toBe(200);
      expect(empty?.status === 200 && readdirSync(dir)).toEqual([]);
      expect((await call("/api/pi/settings", { method: "PUT" }))?.status).toBe(400);
    });
  });
});

describe("native Pi RPC passthrough", () => {
  const rpc = (command: unknown, registry: PiNativeControl = control()) => call("/api/pi/rpc", post("/api/pi/rpc", { pane_id: paneId, command }), registry);

  it("refuses a command outside the allowlist, its unknown fields and a value outside its own set", async () => {
    for (const command of [{ type: "get_messages" }, { type: "prompt", message: "hi", images: [] }, { type: "abort", id: "x" }, { type: "nonsense" }, { nope: 1 }, "abort"]) {
      const response = await rpc(command);
      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({ error: { code: "invalid_command" } });
    }
    // a field of another kind, and a closed set's own spelling
    expect((await rpc({ type: "set_auto_compaction", enabled: "yes" }))?.status).toBe(400);
    expect((await rpc({ type: "prompt", message: "hi", streamingBehavior: "later" }))?.status).toBe(400);
  });

  it("lets a bash command name itself, and refuses a name that is not the chat's own prefix", async () => {
    const seen: { paneId: string; command: Record<string, unknown> }[] = [];
    const registry = control({ call: async (id, command) => { seen.push({ paneId: id, command }); return { output: "ok" }; } });
    expect((await rpc({ type: "bash", id: "web-bash-7", command: "ls", excludeFromContext: true }, registry))?.status).toBe(200);
    expect(seen).toEqual([{ paneId, command: { type: "bash", id: "web-bash-7", command: "ls", excludeFromContext: true } }]);
    // spaces, and a name pi itself could answer to: neither may reach the child
    expect((await rpc({ type: "bash", id: "not a token", command: "ls" }))?.status).toBe(400);
    expect((await rpc({ type: "bash", id: "req-1", command: "ls" }))?.status).toBe(400);
  });

  it("passes an allowed command unchanged and answers with Pi's data", async () => {
    const seen: { paneId: string; command: Record<string, unknown> }[] = [];
    const registry = control({ call: async (id, command) => { seen.push({ paneId: id, command }); return { levels: ["off", "high"] }; } });
    const response = await rpc({ type: "get_available_thinking_levels" }, registry);
    expect(await response?.json()).toEqual({ levels: ["off", "high"] });
    expect(seen).toEqual([{ paneId, command: { type: "get_available_thinking_levels" } }]);
  });

  it("answers a child's refusal with 502 and Pi's own words", async () => {
    const registry = control({ call: async () => { throw new Error("pi has exited"); } });
    const response = await rpc({ type: "get_state" }, registry);
    expect(response?.status).toBe(502);
    expect(await response?.json()).toMatchObject({ error: { code: "command_failed", message: "pi has exited" } });
  });

  it("switches only to a session file inside Pi's store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-pi-switch-"));
    const before = process.env["PI_CODING_AGENT_SESSION_DIR"];
    process.env["PI_CODING_AGENT_SESSION_DIR"] = dir;
    const session = join(dir, "session.jsonl");
    writeFileSync(session, "{}\n");
    try {
      const outside = await rpc({ type: "switch_session", sessionPath: join(dir, "..", "elsewhere.jsonl") });
      expect(outside?.status).toBe(400);
      expect(await outside?.json()).toMatchObject({ error: { code: "invalid_session_path" } });
      const seen: Record<string, unknown>[] = [];
      const registry = control({ call: async (_id, command) => { seen.push(command); return { cancelled: false }; } });
      expect((await rpc({ type: "switch_session", sessionPath: session }, registry))?.status).toBe(200);
      expect(seen).toEqual([{ type: "switch_session", sessionPath: session }]);
    } finally {
      if (before === undefined) delete process.env["PI_CODING_AGENT_SESSION_DIR"];
      else process.env["PI_CODING_AGENT_SESSION_DIR"] = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports to a temp file of the server's own, never the path a client names, and streams it back", async () => {
    const seen: Record<string, unknown>[] = [];
    const registry = control({
      call: async (_id, command) => {
        seen.push(command);
        writeFileSync(command["outputPath"] as string, "<html>session</html>");
        return { path: command["outputPath"] };
      },
    });
    const response = await rpc({ type: "export_html", outputPath: "/tmp/client-chosen.html" }, registry);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/html");
    expect(response?.headers.get("content-disposition")).toContain("attachment");
    expect(await response?.text()).toBe("<html>session</html>");
    const written = seen[0]?.["outputPath"] as string;
    expect(written).not.toBe("/tmp/client-chosen.html");
    expect(written.startsWith(tmpdir())).toBe(true);
    // the temp file leaves with the answer
    expect(() => readFileSync(written)).toThrow();
  });
});
