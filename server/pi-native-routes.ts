/**
 * The native Pi routes: take a pane over in the chat, hand it back to its terminal, reconnect a
 * lost child, and read the live state one pane's registry holds. Nothing here drives pi itself;
 * the registry does, and every answer is its own or a refusal it threw.
 *
 * `pane_id` is checked against herdr's snapshot before the registry is asked, so a pane the
 * terminal no longer has is a 404 and its map entry is dropped, not a child spawned for nobody.
 */
import { sessionSnapshot } from "./herdr/client.ts";import { badRequest, errorResponse, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { type PiNativeControl, PiNeedsTrustError, PiNativeError, type PiTrust } from "./pi-native.ts";

export interface PiNativeRoutesOptions {
  registry: PiNativeControl;
  /** herdr's panes now; tests pass their own */
  snapshot?: () => Promise<{ panes: readonly { pane_id: string }[] }>;
}

const NATIVE_PATHS = new Set(["/api/pi/takeover", "/api/pi/handback", "/api/pi/reconnect", "/api/pi/state"]);

const isTrust = (value: unknown): value is PiTrust => value === "approve" || value === "deny";

/** The answer for a native Pi route, or null when the path is not one. */
export async function handlePiNativeRequest(
  request: Request,
  url: URL,
  pathname: string,
  options: PiNativeRoutesOptions,
): Promise<Response | null> {
  if (!NATIVE_PATHS.has(pathname)) return null;
  setRequestRoute(pathname);
  const reading = pathname === "/api/pi/state";
  if (reading ? request.method !== "GET" : request.method !== "POST") {
    return badRequest("method_not_allowed", reading ? "use GET" : "use POST");
  }

  let paneId: string | null = null;
  let trust: PiTrust | undefined;
  if (reading) {
    paneId = url.searchParams.get("pane_id");
  } else {
    const payload = await readJsonObject<{ pane_id?: unknown; trust?: unknown }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
    if (payload.trust !== undefined && !isTrust(payload.trust)) return badRequest("invalid_trust", "trust must be approve or deny");
    paneId = payload.pane_id;
    trust = payload.trust;
  }
  if (paneId === null || paneId.length === 0) return badRequest("missing_pane_id", "pane_id is required");

  try {
    const snapshot = await (options.snapshot ?? sessionSnapshot)();
    options.registry.prune(snapshot.panes.map((pane) => pane.pane_id));
    if (!snapshot.panes.some((pane) => pane.pane_id === paneId)) {
      return jsonResponse({ error: { code: "pane_not_found", message: `no such pane ${paneId}` } }, 404);
    }
    if (pathname === "/api/pi/state") {
      const state = options.registry.state(paneId);
      if (state === null) return jsonResponse({ error: { code: "not_native", message: "this pane is not driven by the chat" } }, 404);
      return jsonResponse(state, 200, { "cache-control": "no-store" });
    }
    if (pathname === "/api/pi/takeover") return jsonResponse(await options.registry.takeover(paneId, trust === undefined ? {} : { trust }));
    if (pathname === "/api/pi/reconnect") return jsonResponse(await options.registry.reconnect(paneId));
    await options.registry.handBack(paneId);
    return jsonResponse({ ok: true });
  } catch (error) {
    if (error instanceof PiNeedsTrustError) {
      return jsonResponse({ error: { code: "needs_trust", message: error.message }, folder: error.folder, found: error.found }, 409);
    }
    if (error instanceof PiNativeError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return errorResponse(error);
  }
}
