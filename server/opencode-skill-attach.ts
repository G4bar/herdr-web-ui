/**
 * OpenCode v2 attaches a skill only when its own TUI autocomplete row is accepted
 * (packages/tui/src/component/prompt/autocomplete.tsx registers `prompt.skills`; core's
 * session/prompt.ts reads `input.skills`, at 843a6c51): a pasted `@id` stays plain text. So each
 * `@<id>` skill token is typed, its row read off the screen, and accepted with the recorded key.
 * The callers keep their own ownership, identity, held-draft and single-delivery checks; every
 * write here asks `allowed` first, as theirs do.
 */
import { ANSI_RE } from "./dialogs/shared.ts";
import { HerdrError, paneRead, paneSendKeys, paneSendText } from "./herdr/client.ts";

/** the key that accepted the selected row in the 2.0.32 recordings (fixtures opencode-autocomplete-2.0.32-skill-*) */
export const OPENCODE_SKILL_ACCEPT_KEY = "Tab";
export const OPENCODE_SKILL_ROW_WAIT_MS = 2_000;
const ROW_POLL_MS = 50;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Whether the screen shows the autocomplete exactly as recorded on 2.0.32 (fixtures
 * opencode-autocomplete-2.0.32-skill-{narrow,wide}), with `@id` as its selected skill row:
 * - a box of rows `┃ … ┃` sharing one left and one right border, whose first row is
 *   `@id [description]` padded to the kind label `skill` (autocomplete.tsx labels[kind]);
 * - right under it, at the same left border: a bare `┃`, the input row(s) ending in the typed
 *   `@id`, a bare `┃`, the agent/model row, and the prompt's bottom edge `╹▀…` as wide as the box.
 * The selection is drawn only in color; the TUI resets it to the first row whenever the query
 * changes, so the first row is the selected one. Anything else (another kind with the same
 * `@id`, another layout) is not recognized, and the token stays plain text.
 */
export function skillRowSelected(screen: string, id: string): boolean {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/u).map((line) => line.trimEnd());
  const boxRow = /^( *)┃ (.*) ┃$/u;
  const first = lines.findIndex((line) => boxRow.test(line));
  if (first < 0) return false;
  const [, indent = "", selected = ""] = boxRow.exec(lines[first]!)!;
  const width = Bun.stringWidth(lines[first]!);
  if (!new RegExp(`^@${escape(id)}(?: .*\\S)?\\s{2,}skill$`, "u").test(selected)) return false;
  let at = first + 1;
  while (at < lines.length && boxRow.exec(lines[at]!)?.[1] === indent && Bun.stringWidth(lines[at]!) === width) at++;
  if (at < lines.length && boxRow.test(lines[at]!)) return false;
  const bare = `${indent}┃`;
  const filled = new RegExp(`^${indent}┃ +\\S`, "u");
  if (lines[at++] !== bare) return false;
  const input = at;
  while (at < lines.length && filled.test(lines[at]!) && !lines[at]!.endsWith(`@${id}`)) at++;
  if (at >= lines.length || !new RegExp(`^${indent}┃ +(?:.* )?@${escape(id)}$`, "u").test(lines[at]!) || at - input > 8) return false;
  at++;
  // the prompt's bottom edge spans the box's own width, as in both recordings (39 and 98 columns)
  const bottom = lines[at + 2] ?? "";
  return lines[at] === bare && filled.test(lines[at + 1] ?? "") && new RegExp(`^${indent}╹▀+$`, "u").test(bottom) && Bun.stringWidth(bottom) === width;
}

/** The `@id` tokens of `text` that name one of `skills`, in order, each once. */
export function skillTokens(text: string, skills: readonly string[]): string[] {
  const known = new Set(skills);
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@(\S+)/gu)) {
    const id = match[1]!;
    if (known.has(id) && !found.includes(id)) found.push(id);
  }
  return found;
}

export interface SkillAttachIo {
  sendText(text: string, allowed: () => boolean): Promise<void>;
  sendKeys(keys: string[], allowed: () => boolean): Promise<void>;
  screen(): Promise<string>;
  wait(ms: number): Promise<void>;
  now(): number;
}

export const herdrSkillAttachIo = (paneId: string): SkillAttachIo => ({
  sendText: (text, allowed) => paneSendText(paneId, text, undefined, allowed),
  sendKeys: (keys, allowed) => paneSendKeys(paneId, keys, undefined, allowed),
  screen: async () => (await paneRead({ paneId, source: "detection", format: "text" })).text,
  // fixed wait: the poll interval of typeWithSkills' deadline-bounded read of the autocomplete row
  wait: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
});

const paste = (text: string): string => `\u001b[200~${text}\u001b[201~`;

/** What reached the prompt, piece by piece: typed keys, or one bracketed paste (OpenCode treats them differently). */
export type PromptPiece = { typed: string } | { pasted: string };

/**
 * Types `text` (without its Enter) with each `@id` of `skills` through the autocomplete. A token
 * whose row is not recognized within OPENCODE_SKILL_ROW_WAIT_MS stays plain text (a space closes
 * the box), and is reported missed. Throws HerdrError cancelled when `allowed` refuses a write.
 * `revalidate` re-runs the caller's ownership, session-identity and state checks (they await herdr)
 * right before every write, so nothing is typed into a session that replaced the one checked.
 */
export async function typeWithSkills(text: string, skills: readonly string[], allowed: () => boolean, io: SkillAttachIo, revalidate: () => Promise<void>): Promise<{ attached: string[]; missed: string[]; prompt: PromptPiece[] }> {
  const attached: string[] = [];
  const missed: string[] = [];
  const prompt: PromptPiece[] = [];
  const write = async (send: () => Promise<void>): Promise<void> => {
    await revalidate();
    if (!allowed()) throw new HerdrError("cancelled", "The message's sender may no longer type into this pane");
    await send();
  };
  const tokens = skillTokens(text, skills);
  let rest = text;
  let afterAccept = false;
  for (const id of tokens) {
    const match = new RegExp(`(^|\\s)@${id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=\\s|$)`, "u").exec(rest);
    if (!match) continue;
    let before = rest.slice(0, match.index + match[1]!.length);
    if (afterAccept) before = before.replace(/^ /u, "");
    if (before) { await write(() => io.sendText(paste(before), allowed)); prompt.push({ pasted: before }); }
    rest = rest.slice(match.index + match[0].length);
    await write(() => io.sendText(`@${id}`, allowed));
    let seen = false;
    for (const deadline = io.now() + OPENCODE_SKILL_ROW_WAIT_MS; !(seen = skillRowSelected(await io.screen(), id)) && io.now() < deadline;) await io.wait(ROW_POLL_MS);
    if (seen) {
      await write(() => io.sendKeys([OPENCODE_SKILL_ACCEPT_KEY], allowed));
      // the accepted row puts the id and one space in the prompt (recorded)
      prompt.push({ typed: `@${id} ` });
      attached.push(id);
      afterAccept = true;
    } else {
      missed.push(id);
      afterAccept = false;
      prompt.push({ typed: `@${id}` });
      if (!/^\s/u.test(rest)) { await write(() => io.sendText(" ", allowed)); prompt.push({ typed: " " }); }
    }
  }
  if (afterAccept) rest = rest.replace(/^ /u, "");
  if (rest) { await write(() => io.sendText(paste(rest), allowed)); prompt.push({ pasted: rest }); }
  return { attached, missed, prompt };
}
