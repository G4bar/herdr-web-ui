/**
 * What a Pi pane's composer draws for the pane's mode (DS §3.0, §4.1). Only a pane the chat drives
 * over RPC has live chips: while Pi starts they cannot be pressed and the status line says so, and
 * a child that exited adds the Lost notice with its Reconnect and keeps the draft. A Pi the
 * terminal still owns shows what the session file last recorded, read-only; every other agent
 * draws none of it.
 */
import type { PiNativeState } from "../../shared/protocol.ts";

/** How long a model or thinking change waits before it is announced, so rapid cycling says only the last (DS §8.3). */
export const PI_ANNOUNCE_MS = 300;

export interface PiComposerMode {
  /** the model and thinking chips are drawn: a native pane, or a terminal-owned Pi that named a model */
  chips: boolean;
  /** connecting or lost: a chip keeps its words and cannot be pressed */
  disabled: boolean;
  /** the terminal owns Pi: a chip reads the value, and says where it is changed */
  readOnly: boolean;
  /** Pi's child exited: the notice over the card says so, and offers Reconnect */
  lost: boolean;
  /** Pi's RPC is starting: the status line says so */
  connecting: boolean;
}

export function piComposerMode(state: { agent: string | null; piNative: PiNativeState | null; modelKnown: boolean }): PiComposerMode {
  const mode = state.agent === "pi" ? state.piNative?.mode ?? null : null;
  const terminalOwned = state.agent === "pi" && mode === null && state.modelKnown;
  return {
    chips: mode !== null || terminalOwned,
    disabled: mode !== null && mode !== "native",
    readOnly: terminalOwned,
    lost: mode === "lost",
    connecting: mode === "connecting",
  };
}

/** The words the two chips draw, as the change between two renders sees them. */
export interface PiChipsDrawn {
  model: string | null;
  level: string | null;
}

/**
 * Which of the chips a render changed, for the one sentence read after it (DS §8.3): a new model
 * before a new level, since `set_model` can reset the level as well, and nothing for the first value
 * drawn or for a pane that stopped being native (null either side).
 */
export function piChipChange(before: PiChipsDrawn | null, next: PiChipsDrawn | null): "model" | "level" | null {
  if (before === null || next === null) return null;
  if (next.model !== null && before.model !== next.model) return "model";
  if (next.level !== null && before.level !== next.level) return "level";
  return null;
}
