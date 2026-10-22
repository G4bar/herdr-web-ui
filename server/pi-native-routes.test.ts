import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
): Promise<Response | null> {
  const url = new URL(`http://ovis${pathAndQuery}`);
  return handlePiNativeRequest(new Request(url, init), url, url.pathname, { registry, snapshot: async () => ({ panes }) });
}

const post = (pathname: string, body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

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
