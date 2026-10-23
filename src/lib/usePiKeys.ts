/**
 * Pi's own keys in the message box (DS §6.1). Pi names actions and their chords in
 * `~/.pi/agent/keybindings.json`; the server reads that file (`GET /api/pi/keybindings`) and this hook
 * applies the remaps to the actions the web has a surface for, over Pi's own defaults. It is attached
 * to the message box alone: a Pi key never acts in the terminal or anywhere else, and a chord with no
 * handler here is left to the browser untouched, so `Ctrl+P` prints in a browser left it to only when
 * the chat actually takes that key.
 */
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";

export type PiKeyAction =
  | "model-picker" | "model-next" | "model-previous"
  | "thinking-cycle" | "thinking-toggle" | "tools-expand"
  | "message-follow-up" | "message-dequeue";

/** What the box does with the chord. */
export type PiKeyPress = PiKeyAction | "clear";

/** The Pi actions the web offers, in the order a chord is tried; only these ids are read from the file. */
export const PI_KEY_ACTIONS: Readonly<Record<string, PiKeyAction>> = {
  "app.model.select": "model-picker",
  "app.model.cycleForward": "model-next",
  "app.model.cycleBackward": "model-previous",
  "app.thinking.cycle": "thinking-cycle",
  "app.thinking.toggle": "thinking-toggle",
  "app.tools.expand": "tools-expand",
  "app.message.followUp": "message-follow-up",
  "app.message.dequeue": "message-dequeue",
};

/** Pi's defaults for those ids (docs/keybindings.md), for an action the file names none of. */
export const PI_KEY_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  "app.model.select": ["ctrl+l"],
  "app.model.cycleForward": ["ctrl+p"],
  "app.model.cycleBackward": ["shift+ctrl+p"],
  "app.thinking.cycle": ["shift+tab"],
  "app.thinking.toggle": ["ctrl+t"],
  "app.tools.expand": ["ctrl+o"],
  "app.message.followUp": ["alt+enter"],
  "app.message.dequeue": ["alt+up"],
};

/** The effective chords of each action id; `[]` disables one, as Pi reads it. */
export type PiKeymap = Record<string, readonly string[]>;

/** One key as Pi's syntax writes it: `ctrl+shift+p`, `alt+enter`, `shift+tab`. */
export interface PiChord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

export interface PiChordEvent {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

const PI_MODIFIERS = ["ctrl", "shift", "alt", "super"] as const;

/** The named keys Pi's syntax allows, spelled as the syntax spells them. */
const PI_NAMED_KEYS = new Set(["escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear", "home", "end", "pageup", "pagedown", "up", "down", "left", "right"]);

/** The browser's `event.key`, as Pi's syntax names the same key. */
const EVENT_KEY_NAMES: Readonly<Record<string, string>> = {
  Escape: "escape", Enter: "enter", Tab: "tab", " ": "space", Backspace: "backspace", Delete: "delete",
  Insert: "insert", Clear: "clear", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
};

/**
 * One chord of Pi's syntax, or null for a value it does not allow (and for `+` itself, which the
 * `+` that splits modifiers leaves no room for): the box ignores what it cannot express.
 */
export function parsePiChord(value: string): PiChord | null {
  const parts = value.trim().toLowerCase().split("+");
  const key = parts.pop();
  if (key === undefined || key === "") return null;
  const chord: PiChord = { ctrl: false, shift: false, alt: false, meta: false, key };
  for (const part of parts) {
    if (!(PI_MODIFIERS as readonly string[]).includes(part)) return null;
    if (part === "super") chord.meta = true;
    else if (part === "ctrl") chord.ctrl = true;
    else if (part === "shift") chord.shift = true;
    else chord.alt = true;
  }
  const named = PI_NAMED_KEYS.has(key) ? (key === "esc" ? "escape" : key === "return" ? "enter" : key) : null;
  if (named !== null) return { ...chord, key: named };
  if (/^f([1-9]|1[0-2])$/.test(key) || (key.length === 1 && /[a-z0-9`\-=[\]\\;',./!@#$%^&*()_|~{}:<>?]/.test(key))) return chord;
  return null;
}

/** The chord a browser event holds, as Pi's syntax names the same keys. */
export function piChordOf(event: PiChordEvent): PiChord {
  return {
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    key: EVENT_KEY_NAMES[event.key] ?? event.key.toLowerCase(),
  };
}

/** The file's answer (`{ keys }`), merged over Pi's defaults: a string is one chord, an array is many, `[]` disables. */
export function piKeymap(data: unknown): PiKeymap {
  const map: PiKeymap = { ...PI_KEY_DEFAULTS };
  const keys = (data as { keys?: unknown } | null)?.keys;
  if (keys === null || typeof keys !== "object") return map;
  for (const id of Object.keys(PI_KEY_ACTIONS)) {
    const value = (keys as Record<string, unknown>)[id];
    if (typeof value === "string") map[id] = [value];
    else if (Array.isArray(value)) map[id] = value.filter((chord): chord is string => typeof chord === "string");
  }
  return map;
}

const sameChord = (a: PiChord, b: PiChord): boolean => a.key === b.key && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta;

/** The action a pressed chord names, or null: what this map binds, first id first. */
export function matchPiKey(event: PiChordEvent, map: PiKeymap): PiKeyAction | null {
  if (event.isComposing || event.keyCode === 229) return null;
  const pressed = piChordOf(event);
  for (const [id, action] of Object.entries(PI_KEY_ACTIONS)) {
    for (const text of map[id] ?? []) {
      const chord = parsePiChord(text);
      if (chord !== null && sameChord(chord, pressed)) return action;
    }
  }
  return null;
}

/** What the box holds, as Ctrl+C reads it: a selection is copied natively, an empty one clears. */
export interface PiBoxLike {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * What a keypress in the message box does, or null for one the browser keeps. Off (`Pi keys in the
 * message box`) releases every chord, Shift+Tab included, so a keyboard-only reader leaves the box
 * backward again (DS §8.1 2.1.2).
 */
export function piKeyPress(event: PiChordEvent, box: PiBoxLike, map: PiKeymap, enabled: boolean): PiKeyPress | null {
  if (!enabled) return null;
  const named = matchPiKey(event, map);
  if (named !== null) return named;
  // DS §6.1: Ctrl+C never exits, copies a selection natively, and clears the box on an empty one
  const bare = event.key.toLowerCase() === "c" && event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
  return bare && box.selectionStart === box.selectionEnd && box.value !== "" ? "clear" : null;
}

export interface PiKeyHandlers {
  /** Ctrl+L: the model picker, over the chip that draws the model */
  modelPicker?: () => void;
  modelNext?: () => void;
  modelPrevious?: () => void;
  thinkingCycle?: () => void;
  thinkingToggle?: () => void;
  toolsExpand?: () => void;
  followUp?: () => void;
  dequeue?: () => void;
  /** Ctrl+C on an empty selection: the box is cleared, undoably */
  clearBox?: () => void;
}

const HANDLER: Readonly<Record<PiKeyAction, keyof PiKeyHandlers>> = {
  "model-picker": "modelPicker",
  "model-next": "modelNext",
  "model-previous": "modelPrevious",
  "thinking-cycle": "thinkingCycle",
  "thinking-toggle": "thinkingToggle",
  "tools-expand": "toolsExpand",
  "message-follow-up": "followUp",
  "message-dequeue": "dequeue",
};

let requested: Promise<PiKeymap> | null = null;

/** `GET /api/pi/keybindings`, once per page: Pi's defaults for a server that does not answer. */
async function fetchPiKeymap(): Promise<PiKeymap> {
  try {
    const response = await fetch("/api/pi/keybindings", { cache: "no-store" });
    return response.ok ? piKeymap(await response.json()) : { ...PI_KEY_DEFAULTS };
  } catch {
    return { ...PI_KEY_DEFAULTS };
  }
}

/** The chords the box listens for: Pi's defaults until the file's own answer lands. */
export function usePiKeymap(enabled: boolean): PiKeymap {
  const [map, setMap] = useState<PiKeymap>(() => ({ ...PI_KEY_DEFAULTS }));
  useEffect(() => {
    if (!enabled) return;
    requested ??= fetchPiKeymap();
    let live = true;
    void requested.then((next) => { if (live) setMap(next); });
    return () => { live = false; };
  }, [enabled]);
  return map;
}

/**
 * One keydown handler for the message box, run after the completion menu has had its keys. True means
 * the chord was the box's and the browser's default is cancelled; false leaves it alone.
 */
export function usePiKeys(enabled: boolean, handlers: PiKeyHandlers): (event: KeyboardEvent<HTMLTextAreaElement>) => boolean {
  const map = usePiKeymap(enabled);
  return useCallback((event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const press = piKeyPress(event.nativeEvent, event.currentTarget, map, enabled);
    if (press === null) return false;
    const run = press === "clear" ? handlers.clearBox : handlers[HANDLER[press]];
    if (run === undefined) return false;
    event.preventDefault();
    run();
    return true;
  }, [enabled, handlers, map]);
}
