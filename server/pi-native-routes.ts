/**
 * The native Pi routes: take a pane over in the chat, hand it back to its terminal, reconnect a
 * lost child, read the live state one pane's registry holds, and pass one allowlisted RPC command
 * to its child. Nothing here drives pi itself; the registry does, and every answer is its own or a
 * refusal it threw.
 *
 * `pane_id` is checked against herdr's snapshot before the registry is asked, so a pane the
 * terminal no longer has is a 404 and its map entry is dropped, not a child spawned for nobody.
 */
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionSnapshot } from "./herdr/client.ts";
import { badRequest, errorResponse, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { type PiNativeControl, PiNeedsTrustError, PiNativeError, type PiTrust } from "./pi-native.ts";
import { defaultPiSessionDir, piTranscriptInStore } from "./pi.ts";

export interface PiNativeRoutesOptions {
  registry: PiNativeControl;
  /** herdr's panes now; tests pass their own */
  snapshot?: () => Promise<{ panes: readonly { pane_id: string }[] }>;
}

const NATIVE_PATHS = new Set(["/api/pi/takeover", "/api/pi/handback", "/api/pi/reconnect", "/api/pi/state", "/api/pi/rpc"]);

/**
 * The RPC commands the chat may send to a native pane's child, and the fields each may carry: the
 * allowlist is the trust boundary, so a type or field not named here never reaches pi. `bash` runs
 * a shell command as the pane's own Pi would (`!`), the same trust as typing it in the terminal.
 */
const RPC_COMMANDS: Record<string, Record<string, "string" | "boolean">> = {
  abort: {},
  clear_queue: {},
  get_state: {},
  set_model: { provider: "string", modelId: "string" },
  cycle_model: {},
  get_available_models: {},
  set_thinking_level: { level: "string" },
  cycle_thinking_level: {},
  get_available_thinking_levels: {},
  set_steering_mode: { mode: "string" },
  set_follow_up_mode: { mode: "string" },
  compact: { customInstructions: "string" },
  set_auto_compaction: { enabled: "boolean" },
  set_auto_retry: { enabled: "boolean" },
  abort_retry: {},
  bash: { command: "string", excludeFromContext: "boolean" },
  abort_bash: {},
  get_session_stats: {},
  // the command's own output path is never a client's: the route names a temp file and streams it
  export_html: { outputPath: "string" },
  switch_session: { sessionPath: "string" },
  new_session: { parentSession: "string" },
  fork: { entryId: "string" },
  clone: {},
  get_fork_messages: {},
  get_tree: {},
  get_last_assistant_text: {},
  set_session_name: { name: "string" },
  get_commands: {},
  prompt: { message: "string", streamingBehavior: "string" },
};

/** The closed sets a command's field has to be in; a value outside one is a guess pi would refuse. */
const RPC_VALUES: Record<string, readonly string[]> = {
  "set_steering_mode.mode": ["all", "one-at-a-time"],
  "set_follow_up_mode.mode": ["all", "one-at-a-time"],
  "prompt.streamingBehavior": ["steer", "followUp"],
};

const isTrust = (value: unknown): value is PiTrust => value === "approve" || value === "deny";

/**
 * The command a client sent, cut to the allowlist: an unknown type, an unknown field, a field of
 * another kind or a value outside its closed set is refused, and nothing outside it reaches pi.
 */
function checkedCommand(value: unknown): { command: { type: string } & Record<string, unknown> } | { error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: "command must be an object" };
  const sent = value as Record<string, unknown>;
  const type = sent["type"];
  if (typeof type !== "string" || !Object.hasOwn(RPC_COMMANDS, type)) {
    return { error: `pi's ${typeof type === "string" ? type : "missing"} command is not one the chat may send` };
  }
  const fields = RPC_COMMANDS[type]!;
  const command: { type: string } & Record<string, unknown> = { type };
  for (const [key, kind] of Object.entries(fields)) {
    if (sent[key] === undefined) continue;
    if (typeof sent[key] !== kind) return { error: `${type}'s ${key} must be a ${kind}` };
    const closed = RPC_VALUES[`${type}.${key}`];
    if (closed !== undefined && !closed.includes(sent[key] as string)) return { error: `${type}'s ${key} must be one of ${closed.join(", ")}` };
    command[key] = sent[key];
  }
  for (const key of Object.keys(sent)) {
    if (key !== "type" && !Object.hasOwn(fields, key)) return { error: `${type} takes no ${key}` };
  }
  return { command };
}

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
  let command: { type: string } & Record<string, unknown> = { type: "" };
  if (reading) {
    paneId = url.searchParams.get("pane_id");
  } else {
    const payload = await readJsonObject<{ pane_id?: unknown; trust?: unknown; command?: unknown }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
    if (payload.trust !== undefined && !isTrust(payload.trust)) return badRequest("invalid_trust", "trust must be approve or deny");
    paneId = payload.pane_id;
    trust = payload.trust;
    if (pathname === "/api/pi/rpc") {
      const checked = checkedCommand(payload.command);
      if ("error" in checked) return badRequest("invalid_command", checked.error);
      command = checked.command;
    }
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
    if (pathname === "/api/pi/handback") {
      await options.registry.handBack(paneId);
      return jsonResponse({ ok: true });
    }
    if (command.type === "switch_session") {
      // the chat may switch a pane to a session of Pi's own store, never to a file elsewhere
      if (piTranscriptInStore(command["sessionPath"] as string, defaultPiSessionDir()) === null) {
        return badRequest("invalid_session_path", "sessionPath must be a Pi session file in Pi's session store");
      }
    }
    // export_html writes where this server says, not where a client asks: its file leaves as a download
    const exportPath = command.type === "export_html" ? join(tmpdir(), `pi-session-${randomUUID()}.html`) : null;
    if (exportPath !== null) command = { type: "export_html", outputPath: exportPath };
    const answer = await options.registry.call(paneId, command).catch((error: unknown) => {
      // a child that refused the command, exited under it or could not write the export: Pi's own words
      if (error instanceof PiNativeError) throw error;
      throw new PiNativeError("command_failed", error instanceof Error ? error.message : String(error), 502);
    });
    if (exportPath === null) return jsonResponse(answer ?? {});
    try {
      return new Response(await readFile(exportPath), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-disposition": `attachment; filename="${paneId.replace(/[^\w.-]+/g, "-")}.html"`,
        },
      });
    } finally {
      await unlink(exportPath).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof PiNeedsTrustError) {
      return jsonResponse({ error: { code: "needs_trust", message: error.message }, folder: error.folder, found: error.found }, 409);
    }
    if (error instanceof PiNativeError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return errorResponse(error);
  }
}
