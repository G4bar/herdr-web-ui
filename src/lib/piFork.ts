/**
 * The fork a pane just made (DS §4.9): the message it forked from and the session file Pi held
 * before it, so the chat draws `Forked from "…"` with its Go back (`switch_session`). Kept in
 * memory, keyed `<machine>:<pane>` like lib/piNative.ts: the row belongs to the page that made the
 * fork, since nothing about it is written anywhere.
 */
import { useSyncExternalStore } from "react";

import { paneStorageId } from "../../shared/machines.ts";

export interface PiForkNote {
  /** the forked message's opening words: the row names the message by them */
  from: string;
  /** the file Pi held before the fork; null when it named none, and then there is nowhere to go back to */
  sessionFile: string | null;
}

/** one phrase, not a paragraph: the row is one line of the transcript */
const NAME_CHARS = 80;

/** The name a fork's quiet row uses: its first line with something in it, cut to one phrase. */
export function forkNoteName(text: string): string {
  const first = text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  return first.length > NAME_CHARS ? `${first.slice(0, NAME_CHARS - 1)}…` : first;
}

class PiForks {
  private readonly notes = new Map<string, PiForkNote>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get(key: string | null): PiForkNote | null {
    return key === null ? null : this.notes.get(key) ?? null;
  }

  set(key: string, note: PiForkNote): void {
    const before = this.notes.get(key);
    if (before?.from === note.from && before.sessionFile === note.sessionFile) return;
    this.notes.set(key, note);
    this.notify();
  }

  clear(key: string | null): void {
    if (key === null || !this.notes.delete(key)) return;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const piForks = new PiForks();

/** The note this pane's transcript draws, or null: a row of its own once a fork lands. */
export function usePiForkNote(machineId: string, paneId: string | null): PiForkNote | null {
  const key = paneId === null ? null : paneStorageId(machineId, paneId);
  return useSyncExternalStore(piForks.subscribe, () => piForks.get(key));
}
