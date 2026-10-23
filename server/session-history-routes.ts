/**
 * GET /api/sessions/history?workspace_id=&agent=: the earlier sessions of one agent in a
 * workspace's folder (session-history.ts). A row's first message is prompt text, so a device
 * that may only watch is refused here as well as by the access gate in index.ts, and nothing
 * the listing returns is logged.
 *
 * DELETE /api/sessions/history: one Pi session file, unlinked only when it resolves inside Pi's
 * store and no pane on this PC runs it — neither one of the bridge's own native panes nor one
 * herdr reports holding that path — so a running Pi never loses the file under it.
 */
import { realpathSync, unlinkSync } from "node:fs";
import type { SessionHistoryResponse, SessionSnapshot } from "../shared/protocol.ts";
import { sessionSnapshot } from "./herdr/client.ts";
import { badRequest, conflictResponse, errorResponse, jsonResponse, readJsonObject } from "./http.ts";
import { defaultPiSessionDir, piTranscriptInStore } from "./pi.ts";
import { isSessionHistoryAgent, listSessions, type SessionHistoryOptions } from "./session-history.ts";

export const SESSION_HISTORY_PATH = "/api/sessions/history";

type Snapshot = Pick<SessionSnapshot, "workspaces" | "tabs" | "panes">;

/** The bridge's own native panes: the session file each one's child holds. */
export interface NativePanes {
  sessionFile(paneId: string): string | null;
}

export interface SessionHistoryRouteOptions {
  readOnly: boolean;
  stores?: SessionHistoryOptions;
  snapshot?: () => Promise<Snapshot>;
  /** absent means this bridge drives none */
  native?: NativePanes;
  /** Pi's session store; defaults to the bridge's own */
  sessionDir?: string;
}

/**
 * A workspace's folder: its worktree checkout when herdr names one, else the folder of its
 * first tab's first pane, where herdr opens a new tab.
 */
export function workspaceFolder(snapshot: Pick<SessionSnapshot, "workspaces" | "tabs" | "panes">, workspaceId: string): string | null {
  const workspace = snapshot.workspaces.find((entry) => entry.workspace_id === workspaceId);
  if (!workspace) return null;
  if (workspace.worktree?.checkout_path) return workspace.worktree.checkout_path;
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === workspaceId).sort((a, b) => a.number - b.number);
  for (const tab of tabs) {
    const pane = snapshot.panes.find((entry) => entry.tab_id === tab.tab_id && typeof entry.cwd === "string" && entry.cwd !== "");
    if (pane?.cwd) return pane.cwd;
  }
  return null;
}

export async function handleSessionHistoryRequest(
  request: Request,
  url: URL,
  options: SessionHistoryRouteOptions,
): Promise<Response> {
  if (request.method === "DELETE") return await deleteSession(request, options);
  if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
  if (options.readOnly) return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
  const workspaceId = url.searchParams.get("workspace_id") ?? "";
  if (workspaceId === "") return badRequest("missing_workspace_id", "workspace_id is required");
  const agent = url.searchParams.get("agent") ?? "";
  if (!isSessionHistoryAgent(agent)) return badRequest("invalid_agent", "agent must name an agent whose sessions are listed");
  let snapshot: Snapshot;
  try { snapshot = await readableSnapshot(options); } catch (error) { return errorResponse(error); }
  if (!snapshot.workspaces.some((entry) => entry.workspace_id === workspaceId)) {
    return jsonResponse({ error: { code: "workspace_not_found", message: "no such workspace" } }, 404);
  }
  const cwd = workspaceFolder(snapshot, workspaceId);
  if (cwd === null) return jsonResponse({ error: { code: "no_folder", message: "the workspace has no folder to list sessions for" } }, 409);
  const answer: SessionHistoryResponse = { workspace_id: workspaceId, agent, cwd, sessions: listSessions(agent, cwd, options.stores) };
  const response = jsonResponse(answer);
  response.headers.set("cache-control", "no-store");
  return response;
}

function readableSnapshot(options: SessionHistoryRouteOptions): Promise<Snapshot> {
  return (options.snapshot ?? sessionSnapshot)();
}

/** The canonical form of a path, or null when it is not there to compare. */
const canonical = (path: string): string | null => {
  try { return realpathSync(path); } catch { return null; }
};

/** The pane on this PC holding that session file now: the bridge's own, else one herdr reports. */
function holdingPane(panes: Snapshot["panes"], path: string, native: NativePanes | undefined): Snapshot["panes"][number] | null {
  const same = (value: string | null): boolean => value !== null && value !== "" && canonical(value) === path;
  for (const pane of panes) {
    if (same(native?.sessionFile(pane.pane_id) ?? null)) return pane;
    const session = pane.agent_session;
    if (session?.agent === "pi" && session.kind === "path" && same(session.value)) return pane;
  }
  return null;
}

/** DELETE: one session file the chat may drop, and never one a pane still holds. */
async function deleteSession(request: Request, options: SessionHistoryRouteOptions): Promise<Response> {
  if (options.readOnly) return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
  const body = await readJsonObject<{ agent?: unknown; path?: unknown }>(request);
  if (body instanceof Response) return body;
  if (body.agent !== "pi") return badRequest("invalid_agent", "only Pi's sessions can be deleted");
  if (typeof body.path !== "string" || body.path === "") return badRequest("missing_path", "path is required");
  // the store is checked, not trusted: a path elsewhere, a link out of it or a non-session file is refused
  const path = piTranscriptInStore(body.path, options.sessionDir ?? defaultPiSessionDir());
  if (path === null) return badRequest("invalid_session_path", "path must be a Pi session file in Pi's session store");
  let snapshot: Snapshot;
  try { snapshot = await readableSnapshot(options); } catch (error) { return errorResponse(error); }
  const holder = holdingPane(snapshot.panes, path, options.native);
  if (holder !== null) return conflictResponse("session_live", `This session is running in ${holder.label ?? holder.pane_id}; stop it there first.`);
  try {
    unlinkSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return jsonResponse({ error: { code: "not_found", message: "no such session file" } }, 404);
    return conflictResponse("not_deleted", `the session file could not be deleted (${code ?? "unknown error"})`);
  }
  return jsonResponse({ deleted: path });
}
