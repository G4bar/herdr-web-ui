/**
 * The native Pi routes: take a pane over in the chat, hand it back to its terminal, reconnect a
 * lost child, read the live state one pane's registry holds, read the context files Pi would load
 * for its folder, read the keys Pi's own `keybindings.json` binds, and pass one allowlisted RPC
 * command to its child. Nothing here drives pi itself; the registry does, and every answer is its
 * own or a refusal it threw.
 *
 * `pane_id` is checked against herdr's snapshot before the registry is asked, so a pane the
 * terminal no longer has is a 404 and its map entry is dropped, not a child spawned for nobody.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionSnapshot } from "./herdr/client.ts";
import { badRequest, errorResponse, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { paneContext } from "./pane-context.ts";
import { piContextFiles } from "./pi-context.ts";
import { type PiNativeControl, PiNeedsTrustError, PiNativeError, type PiTrust } from "./pi-native.ts";
import { piAgentDir } from "./pi-models.ts";
import { defaultPiSessionDir, piTranscriptInStore } from "./pi.ts";

export interface PiNativeRoutesOptions {
  registry: PiNativeControl;
  /** herdr's panes now; tests pass their own */
  snapshot?: () => Promise<{ panes: readonly { pane_id: string }[] }>;
  /** the folder a pane works in, read from herdr; tests pass their own */
  paneCwd?: (paneId: string) => Promise<string>;
}

const KEYBINDINGS_PATH = "/api/pi/keybindings";
const SETTINGS_PATH = "/api/pi/settings";

const NATIVE_PATHS = new Set(["/api/pi/takeover", "/api/pi/handback", "/api/pi/reconnect", "/api/pi/state", "/api/pi/rpc", "/api/pi/context", KEYBINDINGS_PATH, SETTINGS_PATH]);

/**
 * Pi's defaults for the actions the chat has a surface for (`docs/keybindings.md`), for an action
 * `keybindings.json` names none of. Only these ids are the chat's business: the rest of Pi's map is
 * the terminal's.
 */
const PI_KEY_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  "app.model.select": ["ctrl+l"],
  "app.model.cycleForward": ["ctrl+p"],
  "app.model.cycleBackward": ["shift+ctrl+p"],
  "app.thinking.cycle": ["shift+tab"],
  "app.thinking.toggle": ["ctrl+t"],
  "app.tools.expand": ["ctrl+o"],
  "app.message.followUp": ["alt+enter"],
  "app.message.dequeue": ["alt+up"],
};

interface PiKeybindings {
  /** the file that was read, or would be */
  path: string;
  /** each action's chords, merged over the defaults; `[]` disables one */
  keys: Record<string, readonly string[]>;
  /** why Pi's defaults are the answer, for a file that is absent or is not Pi's own */
  warning?: string;
}

/**
 * The keys the message box listens for (`src/lib/usePiKeys.ts`), as the user's file remaps them: a
 * string is one chord, an array many and `[]` disables the action. A file that is absent or is not
 * Pi's own flat action→chords document leaves every default in place and says why.
 */
async function piKeybindings(agentDir = piAgentDir()): Promise<PiKeybindings> {
  const path = join(agentDir, "keybindings.json");
  const keys: Record<string, readonly string[]> = { ...PI_KEY_DEFAULTS };
  const fallback = (reason: string): PiKeybindings => ({ path, keys, warning: `${path}: ${reason}; Pi's own keys are used.` });
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return fallback((error as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : "could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback("not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fallback("not a JSON object");
  for (const id of Object.keys(PI_KEY_DEFAULTS)) {
    const value = (parsed as Record<string, unknown>)[id];
    if (typeof value === "string") keys[id] = [value];
    else if (Array.isArray(value)) keys[id] = value.filter((chord): chord is string => typeof chord === "string");
  }
  return { path, keys };
}

/**
 * The `settings.json` keys the web may write (PLAN D8): the startup model and thinking level, and the
 * models Pi's own cycle is scoped to (`docs/settings.md`). Everything else in that file is Pi's.
 */
const PI_SETTINGS_KEYS: Readonly<Record<string, (value: unknown) => boolean>> = {
  defaultProvider: isSettingName,
  defaultModel: isSettingName,
  defaultThinkingLevel: (value) => typeof value === "string" && PI_THINKING_LEVELS.includes(value),
  enabledModels: (value) => Array.isArray(value) && value.every(isSettingName),
};

/** The thinking levels `defaultThinkingLevel` accepts, as Pi's own reference lists them. */
const PI_THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A model or provider id: Pi's own are never blank. */
function isSettingName(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

interface PiSettings {
  /** the file that was read, or would be written */
  path: string;
  /** the allowlisted keys the file holds; a key Pi has not set is absent */
  settings: Record<string, string | readonly string[]>;
}

/**
 * Pi's own file, whole, and why it cannot be read: a file that is not a JSON object is refused
 * rather than overwritten, since every key in it belongs to Pi and its TUI. An absent file is an
 * empty document, which the first write creates.
 */
async function readPiSettings(path: string): Promise<{ file: Record<string, unknown> } | { error: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { file: {} } : { error: `could not be read: ${(error as Error).message}` };
  }
  if (text.trim().length === 0) return { file: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "not a JSON object" };
  return { file: parsed as Record<string, unknown> };
}

/** The allowlisted keys of Pi's file, in the shape the page reads them. */
function piSettingsOf(file: Record<string, unknown>): PiSettings["settings"] {
  const settings: PiSettings["settings"] = {};
  for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel"]) {
    if (typeof file[key] === "string") settings[key] = file[key];
  }
  const models = file["enabledModels"];
  if (Array.isArray(models)) settings["enabledModels"] = models.filter((model): model is string => typeof model === "string");
  return settings;
}

/**
 * Pi's settings, or the answer that says why they cannot be read. A file Pi cannot parse is a 409 for
 * both a read and a write: the page shows the reason instead of a guess, and no key of Pi's is lost.
 */
async function piSettings(): Promise<PiSettings | Response> {
  const path = join(piAgentDir(), "settings.json");
  const read = await readPiSettings(path);
  if ("error" in read) return jsonResponse({ error: { code: "invalid_settings_file", message: `${path}: ${read.error}` } }, 409);
  return { path, settings: piSettingsOf(read.file) };
}

/**
 * The settings writes already under way: each one re-reads Pi's file and replaces it, so two that
 * overlapped would each write back the document they read and one key would be lost.
 */
let settingsWrites: Promise<unknown> = Promise.resolve();

function serialized<T>(run: () => Promise<T>): Promise<T> {
  const next = settingsWrites.then(run, run);
  settingsWrites = next.catch(() => undefined);
  return next;
}

/**
 * Where a settings document is actually written, and the mode it keeps. A `settings.json` a dotfile
 * manager symlinked to its own store stays a link: the write goes beside the file it names, under
 * that file's mode, so neither the link nor a mode the user chose is replaced by a rename.
 */
async function settingsTarget(path: string): Promise<{ path: string; mode: number }> {
  try {
    const real = await realpath(path);
    return { path: real, mode: (await stat(real)).mode & 0o777 };
  } catch {
    // shortcut: a dangling symlink writes a regular file over the link, not to its target
    return { path, mode: 0o600 };
  }
}

/**
 * Writes the keys a client sent, and only those: every other key of Pi's file is carried over as it
 * was, the file is re-read right before it is replaced, and the new document reaches the disk under a
 * temp name so a reader never sees half of one (PLAN D8).
 */
async function writePiSettings(request: Request): Promise<Response> {
  const payload = await readJsonObject(request);
  if (payload instanceof Response) return payload;
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const valid = PI_SETTINGS_KEYS[key];
    if (valid === undefined) return badRequest("unknown_setting", `${key} is not one of the settings the chat may write`);
    if (!valid(value)) return badRequest("invalid_setting", `${key}'s value is not one pi accepts`);
    changes[key] = value;
  }
  const path = join(piAgentDir(), "settings.json");
  return serialized(async () => {
    // the directory exists before the file is read, so the first write creates it, not a temp file
    await mkdir(dirname(path), { recursive: true });
    const read = await readPiSettings(path);
    if ("error" in read) return jsonResponse({ error: { code: "invalid_settings_file", message: `${path}: ${read.error}` } }, 409);
    // nothing to write: Pi's own file is left alone rather than rewritten with the same content
    if (Object.keys(changes).length === 0) return jsonResponse({ path, settings: piSettingsOf(read.file) });
    const next = { ...read.file, ...changes };
    const target = await settingsTarget(path);
    const temp = join(dirname(target.path), `.settings-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: target.mode });
      await chmod(temp, target.mode);
      await rename(temp, target.path);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    return jsonResponse({ path, settings: piSettingsOf(next) });
  });
}

/**
 * The RPC commands the chat may send to a native pane's child, and the fields each may carry: the
 * allowlist is the trust boundary, so a type or field not named here never reaches pi. `bash` runs
 * a shell command as the pane's own Pi would (`!`), the same trust as typing it in the terminal, and
 * may name itself: pi streams a command's output under the id it was sent with, so the chat that
 * started one finds its own lines by the id it chose.
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
  bash: { id: "string", command: "string", excludeFromContext: "boolean" },
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
 * A bash command's own name for itself, as a JSON-RPC id pi echoes back on every line it streams. Its
 * prefix is fixed so a client's id can never take an id pi itself uses (a generated `req-N` or a tool
 * call's own) and so a tail under it is always this chat's own.
 */
const RPC_ID = /^web-bash-[A-Za-z0-9-]{1,48}$/;

/** The folder a pane works in, as herdr has it now: a Terminal-mode Pi loads its context from it too. */
const paneWorkingDir = (paneId: string): Promise<string> => paneContext(paneId).then((context) => context.cwd);

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
  const id = command["id"];
  if (typeof id === "string" && !RPC_ID.test(id)) return { error: `${type}'s id must be web-bash- and letters, digits or -` };
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
  const reading = pathname === "/api/pi/state" || pathname === "/api/pi/context" || pathname === KEYBINDINGS_PATH;
  // Pi's settings are read and written on one path; every other route has one method
  const methods = pathname === SETTINGS_PATH ? ["GET", "POST"] : [reading ? "GET" : "POST"];
  if (!methods.includes(request.method)) return badRequest("method_not_allowed", `use ${methods.join(" or ")}`);
  // one machine's keybindings and one machine's defaults, no pane: the same answer for every chat on it
  if (pathname === KEYBINDINGS_PATH) return jsonResponse(await piKeybindings(), 200, { "cache-control": "no-store" });
  if (pathname === SETTINGS_PATH) {
    if (request.method === "POST") return writePiSettings(request);
    const settings = await piSettings();
    return settings instanceof Response ? settings : jsonResponse(settings, 200, { "cache-control": "no-store" });
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
    // What Pi loads for this folder: the same chain for a Terminal-mode pane, since it comes from
    // herdr's own cwd and Pi's files, not from a child of the chat's
    if (pathname === "/api/pi/context") {
      const cwd = await (options.paneCwd ?? paneWorkingDir)(paneId);
      return jsonResponse({ files: piContextFiles(cwd) }, 200, { "cache-control": "no-store" });
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
    // export_html writes where this server says, not where a client asks: its file leaves as a download,
    // and leaves the temp folder on every path, a refused command included
    const exportPath = command.type === "export_html" ? join(tmpdir(), `pi-session-${randomUUID()}.html`) : null;
    if (exportPath !== null) command = { type: "export_html", outputPath: exportPath };
    try {
      const answer = await options.registry.call(paneId, command).catch((error: unknown) => {
        // a child that refused the command, exited under it or could not write the export: Pi's own words
        if (error instanceof PiNativeError) throw error;
        throw new PiNativeError("command_failed", error instanceof Error ? error.message : String(error), 502);
      });
      if (exportPath === null) return jsonResponse(answer ?? {});
      return new Response(await readFile(exportPath), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-disposition": `attachment; filename="${paneId.replace(/[^\w.-]+/g, "-")}.html"`,
        },
      });
    } finally {
      if (exportPath !== null) await unlink(exportPath).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof PiNeedsTrustError) {
      return jsonResponse({ error: { code: "needs_trust", message: error.message }, folder: error.folder, found: error.found }, 409);
    }
    if (error instanceof PiNativeError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return errorResponse(error);
  }
}
