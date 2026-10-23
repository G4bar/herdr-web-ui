/**
 * The thinking chip of a native Pi pane, its pips and the menu it opens (DS §4.1, §4.3). The chip
 * draws `PiPips` and the level's word as the pane's live state has them (`PiNativeState`), never as
 * a pick left them: a refusal keeps the old level on the chip and says why under the list it left
 * open (DS §3.3). A desktop gets a popover over the chip, a phone the modal primitive, which is a
 * bottom sheet there. The levels are read when it opens (`get_available_thinking_levels`), so one
 * the model does not offer never lists, and they are ordered high→low so ↑ means "think more".
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, LoaderCircle, X } from "lucide-react";

import "./PiThinkingMenu.css";

import { ApiError, savePiSettings, type PiRpcCommand } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { useSheetHistory } from "../lib/sheetHistory.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";

export interface PiThinkingMenuProps {
  /** the pane's level now: its live state, or the session file's for a Pi the terminal owns */
  level: string;
  /** one allowlisted command for the pane's Pi; a refusal throws with Pi's own sentence */
  piRpc: (command: PiRpcCommand) => Promise<unknown>;
  /** the model doesn't think: the chip says `Thinking off` and cannot be pressed (DS §4.1) */
  unsupported?: boolean;
  /** Pi is connecting or lost: the chip cannot be pressed */
  disabled?: boolean;
  /** the terminal owns Pi: the chip reads the level, and says where it is changed */
  readOnly?: boolean;
  /** the chip's row is too narrow for the word (DS §4.1, ≤ 480px): the pips say the level and the
   *  word stays in the button's name, read and not drawn */
  pipsOnly?: boolean;
  /** after a pick: the focus goes back to the message box, not the chip */
  onPicked?: () => void;
  /** the PC whose Pi settings file Save as default writes */
  machineId?: string;
  /** Save as default wrote the level: the composer says so through its status line (DS §4.3) */
  onSavedAsDefault?: () => void;
}

/**
 * Pi's levels, least to most thought (`ThinkingLevel`). `get_available_thinking_levels` answers
 * with the subset this model takes.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** The word each level goes by (DS §4.3). A label map: src/lib/i18n.test.ts finds its keys here. */
const LEVEL_LABEL: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** How many of the five bars a level lights: the lowest off, the highest all five. */
const bars = (level: string): number => Math.max(0, Math.min(5, THINKING_LEVELS.indexOf(level as (typeof THINKING_LEVELS)[number])));

/** The level's word, or Pi's own spelling of one this table has not met. */
export const thinkingLevelLabel = (level: string): string => LEVEL_LABEL[level] ?? level;

/** The levels Pi offered, high→low. `max` is called here, and cannot light a sixth bar. */
export function orderedLevels(data: unknown): string[] {
  const list = (data as { levels?: unknown } | null)?.levels;
  if (!Array.isArray(list)) return [];
  const offered = new Set(list.filter((level): level is string => typeof level === "string"));
  // shortcut: Pi's level set is closed, so one it adds later lists once THINKING_LEVELS names it
  return [...THINKING_LEVELS].reverse().filter((level) => offered.has(level));
}

/**
 * The level's five bars (DS §5.4): bottom aligned, each 3px wide, lit at the level's own `--think-*`
 * colour. `aria-hidden`, with the word always beside it: colour is never the only signal.
 */
export function PiPips({ level }: { level: string }) {
  const lit = bars(level);
  // Pi's `max` draws as xhigh: the ramp has five bars, and `max` is the top of it (src/styles.css)
  const shade = level === "max" ? "xhigh" : level;
  return (
    <span className="pi-pips" data-level={shade} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((bar) => <span key={bar} className={bar < lit ? "is-lit" : undefined} />)}
    </span>
  );
}

const refusal = (error: unknown): string => error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error);

/** How far from a screen edge the popover keeps. */
const EDGE = 8;

export function PiThinkingMenu({ level, piRpc, unsupported, disabled, readOnly, pipsOnly, onPicked, machineId = "local", onSavedAsDefault }: PiThinkingMenuProps) {
  const t = useT();
  const sheet = useMediaQuery(SHEET_QUERY);
  const listId = useId();
  const titleId = useId();
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** a pick closed the menu: the focus goes to the message box, not back to the chip */
  const toBox = useRef(false);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [levels, setLevels] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [active, setActive] = useState(0);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultError, setDefaultError] = useState<string | null>(null);
  const trap = useFocusTrap<HTMLDivElement>(open && sheet, { initialFocus: menuRef, shouldRestore: () => !toBox.current });

  const rows = levels ?? [];
  const word = unsupported === true ? t("Thinking off") : t(thinkingLevelLabel(level));
  const title = unsupported === true
    ? t("This model doesn't think")
    : `${t("Thinking: {level}", { level: word })}${readOnly === true ? ` · ${t("Change it in the terminal")}` : ""}`;

  const dismiss = useCallback((): void => {
    setOpen(false);
    toBox.current = false;
  }, []);

  // a close the user aimed at the menu itself gives the chip its focus back; one a Tab away
  // caused (dismiss) leaves the focus where the keyboard put it
  const close = useCallback((): void => {
    dismiss();
    chipRef.current?.focus({ preventScroll: true });
  }, [dismiss]);

  const load = useCallback((): void => {
    setLevels(null);
    setLoadError(false);
    setSwitchError(null);
    setDefaultError(null);
    void piRpc({ type: "get_available_thinking_levels" }).then(
      (data) => setLevels(orderedLevels(data)),
      () => { setLoadError(true); setLevels([]); },
    );
  }, [piRpc]);

  // the levels are read on every open, never cached: what the model takes can change with the model
  useEffect(() => {
    if (open) load();
  }, [load, open]);

  // the current level is where the list opens, and the list itself takes the keyboard
  useEffect(() => {
    if (!open) return;
    menuRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open || levels === null) return;
    setActive(Math.max(0, levels.indexOf(level)));
  }, [level, levels, open]);

  useEffect(() => {
    if (!open || rows.length === 0) return;
    document.getElementById?.(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId, open, rows.length]);

  // over the chip, right edges aligned, or under it when the screen ends above; Escape, a press
  // outside, a scroll of what holds the chip and a resize close it
  useLayoutEffect(() => {
    if (!open || sheet) return;
    const anchor = chipRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    if (!anchor.isConnected) { setOpen(false); return; }
    const rect = anchor.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = menu;
    const above = rect.top - 4 - height;
    setPlace({
      left: Math.max(EDGE, Math.min(rect.right - width, window.innerWidth - width - EDGE)),
      top: above >= EDGE ? above : Math.min(rect.bottom + 4, window.innerHeight - height - EDGE),
    });
  }, [open, sheet]);

  useEffect(() => {
    if (!open || sheet) return;
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || chipRef.current?.contains(target)) return;
      close();
    };
    const onScroll = (event: Event): void => {
      if (menuRef.current?.contains(event.target as Node)) return;
      dismiss();
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [close, dismiss, open, sheet]);

  // Escape closes it whatever holds the focus in it (the sheet's Close, a row): the list's own keys
  // stay on the list, which is what a pick's Enter and a move's arrows are about
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, open]);

  useSheetSwipe(trap, open && sheet ? close : null);
  useSheetHistory(open && sheet, close);

  const pick = async (option: string): Promise<void> => {
    if (switching !== null) return;
    setSwitching(option);
    setSwitchError(null);
    try {
      await piRpc({ type: "set_thinking_level", level: option });
      toBox.current = true;
      setOpen(false);
      onPicked?.();
    } catch (error) {
      // the list stays open on the level Pi kept, which the chip still draws
      setSwitchError(t("Couldn't switch: {reason}", { reason: refusal(error) }));
    } finally {
      setSwitching(null);
    }
  };

  /** Ctrl+S and the footer's button: the highlighted level becomes the one a new Pi session starts
   *  with (DS §4.3). A refusal says Pi's own sentence and leaves the chip as it was. */
  const saveDefault = async (): Promise<void> => {
    const option = rows[active];
    if (option === undefined || savingDefault) return;
    setSavingDefault(true);
    setDefaultError(null);
    try {
      await savePiSettings({ defaultThinkingLevel: option }, machineId);
      onSavedAsDefault?.();
    } catch (error) {
      setDefaultError(t("Couldn't change {setting}: {reason}", { setting: t("Default thinking level"), reason: refusal(error) }));
    } finally {
      setSavingDefault(false);
    }
  };

  // Ctrl+S is the menu's while it is open, so the browser's save page never runs (DS §6.1). The rows
  // are what holds the focus in both forms; the sheet's footer is beside them, so it takes the key itself.
  const saveShortcut = (event: KeyboardEvent<HTMLElement>): void => {
    if (!event.ctrlKey || event.altKey || event.metaKey || event.key.toLocaleLowerCase() !== "s") return;
    event.preventDefault();
    void saveDefault();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    saveShortcut(event);
    // a key from the footer's button is the button's: Enter presses it, and the arrows are not the list's
    const target = event.target as Element | null;
    if (target?.closest?.(".pi-thinking-footer") != null) return;
    if (rows.length === 0) return;
    const last = rows.length - 1;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(last, index + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(last); }
    else if (event.key === "Enter") {
      event.preventDefault();
      const option = rows[active];
      if (option !== undefined) void pick(option);
    }
  };

  // the footer (DS §4.3): the level the list holds is what a Ctrl+S writes as the default for a new session
  const footer = (
    <>
      <div className="pi-thinking-footer" onKeyDown={sheet ? (event) => { saveShortcut(event); } : undefined}>
        <button type="button" className="btn pi-thinking-save" disabled={rows.length === 0 || savingDefault} onClick={() => void saveDefault()}>
          {t("Save as default")}<kbd className="kbd" aria-hidden="true">Ctrl+S</kbd>
        </button>
      </div>
      {defaultError !== null && <p className="pi-thinking-error" role="alert">{defaultError}</p>}
    </>
  );

  // the rows are the same in both forms; only what holds them and the scrim around the sheet differ
  const list = (
    <>
      {loadError && (
        <p className="pi-thinking-note" role="alert">
          {t("Couldn't load levels")}{" "}
          <button type="button" className="btn pi-thinking-retry" onClick={load}>{t("Try again")}</button>
        </p>
      )}
      {!loadError && levels === null && <p className="pi-thinking-note" role="status">{t("Loading…")}</p>}
      {!loadError && levels !== null && rows.length === 0 && <p className="pi-thinking-note">{t("No thinking levels available.")}</p>}
      {!loadError && rows.map((option, index) => (
        <div
          key={option}
          id={`${listId}-${index}`}
          className="pi-thinking-row"
          role="menuitemradio"
          aria-checked={option === level}
          data-active={index === active || undefined}
          onPointerEnter={() => setActive(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void pick(option)}
        >
          <PiPips level={option} />
          <span className="pi-thinking-word">{t(thinkingLevelLabel(option))}</span>
          {switching === option && <LoaderCircle className="pi-thinking-busy" aria-hidden="true" />}
          {option === level && <Check className="pi-thinking-check" aria-hidden="true" />}
        </div>
      ))}
      {switchError !== null && <p className="pi-thinking-error" role="alert">{switchError}</p>}
    </>
  );

  // a finger holds the sheet from its head; a press on the scrim or the X closes it, as Back does
  const onScrim = (event: MouseEvent<HTMLDivElement>): void => { if (event.target === event.currentTarget) close(); };
  // the keys live on the list alone, in both forms: it is what holds the focus and the active row, and
  // one on the sheet around it would run every key twice (two rows on an arrow, two pick sends)
  const surface = sheet
    ? <div className="modal-scrim" onMouseDown={onScrim}>
      <div ref={trap} className="modal pi-thinking-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={titleId}>{t("Thinking")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={close}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          <div ref={menuRef} className="pi-thinking-list" role="menu" tabIndex={-1} aria-label={t("Thinking")}
            aria-activedescendant={rows.length > 0 ? `${listId}-${active}` : undefined} aria-busy={switching !== null || undefined} onKeyDown={onKeyDown}>
            {list}
          </div>
          {footer}
        </div>
      </div>
    </div>
    : <div
      ref={menuRef}
      className="menu pi-thinking"
      role="menu"
      tabIndex={-1}
      aria-label={t("Thinking")}
      aria-activedescendant={rows.length > 0 ? `${listId}-${active}` : undefined}
      style={place === null ? { left: 0, top: 0, visibility: "hidden" } : { left: place.left, top: place.top }}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next !== null && (menuRef.current?.contains(next) === true || chipRef.current?.contains(next) === true)) return;
        dismiss();
      }}
    >
      {list}
      {footer}
    </div>;

  return (
    <span className="pi-thinking-chip">
      <button
        ref={chipRef}
        type="button"
        className="pi-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-disabled={readOnly === true || unsupported === true || undefined}
        disabled={disabled}
        title={title}
        onClick={() => {
          if (open) close();
          else if (readOnly !== true && unsupported !== true && !disabled) { toBox.current = false; setPlace(null); setOpen(true); }
        }}
      >
        <PiPips level={unsupported === true ? "off" : level} />
        <span className={pipsOnly === true ? "pi-chip-level visually-hidden" : "pi-chip-level"}>{word}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && createPortal(surface, document.body)}
    </span>
  );
}
