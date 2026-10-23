/**
 * Pi's slash commands that the chat runs as its own surface instead of sending them to Pi as a
 * prompt (DS §4.12): the completion menu and an Enter on a typed command read this one table, so
 * each command has a single answer, and a later phase adds its own command here (`/tree`, `/fork`,
 * `/settings`, `/scoped-models`). `/resume` keeps the composer's own path, which predates the table.
 *
 * A command taking an argument the chat cannot honour (`/model sonnet`, `/export /tmp/x.html`) is
 * not the chat's either: Pi's built-in TUI commands do not run through `prompt` — one sent there
 * reaches the model as a message and starts a paid run — but a message that looks like one is
 * still the user's to send, never silently dropped. `/reload` is one of those built-ins
 * (docs/rpc-commands.md), so it is not a surface here.
 */
export type PiSlashSurface =
  | { kind: "model" }
  | { kind: "new" }
  | { kind: "name"; name: string }
  | { kind: "compact"; instructions: string | null }
  | { kind: "session" }
  | { kind: "export" }
  | { kind: "copy" }
  | { kind: "hotkeys" }
  | { kind: "settings" }
  | { kind: "scopedModels" }
  | { kind: "context" }
  // an OAuth dance needs Pi's own TUI, so these open the terminal (DS §4.12)
  | { kind: "terminal"; command: string };

/** What a command's argument makes of it; null: not the chat's, so it goes to `prompt` as typed. */
type SurfaceFor = (argument: string) => PiSlashSurface | null;

/** The bare form only: an argument the surface has no use for leaves the message as it was. */
const bare = (surface: PiSlashSurface): SurfaceFor => (argument) => (argument === "" ? surface : null);

const SURFACES: Readonly<Record<string, SurfaceFor>> = {
  model: bare({ kind: "model" }),
  new: bare({ kind: "new" }),
  // a name is the command's argument; `/name` alone is Pi's own to answer
  name: (argument) => (argument === "" ? null : { kind: "name", name: argument }),
  compact: (argument) => ({ kind: "compact", instructions: argument === "" ? null : argument }),
  session: bare({ kind: "session" }),
  export: bare({ kind: "export" }),
  copy: bare({ kind: "copy" }),
  hotkeys: bare({ kind: "hotkeys" }),
  // Settings → Pi, and the Scoped models dialog it holds (DS §4.12)
  settings: bare({ kind: "settings" }),
  "scoped-models": bare({ kind: "scopedModels" }),
  context: bare({ kind: "context" }),
  login: bare({ kind: "terminal", command: "/login" }),
  logout: bare({ kind: "terminal", command: "/logout" }),
};

/**
 * The surface `text` asks for, or null for a message that is not one: only a lone `/command` (its
 * argument on the same line) counts, so prose that mentions one, a second line after it, or a path
 * under a `/` is a message as it always was. A menu row's name reads the same way, its argument, if
 * the command takes one, typed after it.
 */
export function piSlashSurface(text: string): PiSlashSurface | null {
  const match = /^\/([^\s/]\S*)(?:[ \t]+([^\n]*))?$/u.exec(text.trim());
  if (match === null) return null;
  const surface = SURFACES[match[1]!.toLocaleLowerCase()];
  return surface === undefined ? null : surface((match[2] ?? "").trim());
}
