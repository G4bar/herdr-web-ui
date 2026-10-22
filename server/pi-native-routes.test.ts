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
