/**
 * The model chip of a native Pi pane, and the picker it opens (DS §4.1, §4.2). A desktop gets a
 * popover over the chip, a phone the modal primitive, which is a bottom sheet there; both hold a
 * combobox (the search) and a listbox whose selection is `aria-activedescendant`, so the focus
 * never leaves the field. The list is read when it opens (`get_available_models`) and grouped by
 * provider; a pick sends `set_model` and closes, and the chip takes its words from the pane's live
 * state (`PiNativeState`), never from the pick: a refusal leaves the old model drawn and says why
 * under the row it was about (DS §3.3).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, LoaderCircle, X } from "lucide-react";

import "./PiModelPicker.css";

import { ApiError, type PiRpcCommand } from "../lib/api.ts";
import { formatTokens } from "../lib/compose.ts";
import { useT } from "../lib/i18n.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { useSheetHistory } from "../lib/sheetHistory.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";

export interface PiModelPickerProps {
  /** the chip's words: the pane's own model, or the model pill's name before Pi answers */
  label: string;
  /** the row that stands for the pane's model now; null while only the name is known */
  current: { provider: string; id: string } | null;
  /** one allowlisted command for the pane's Pi; a refusal throws with Pi's own sentence */
  piRpc: (command: PiRpcCommand) => Promise<unknown>;
  /** Pi is connecting or lost: the chip cannot be pressed */
  disabled?: boolean;
  /** the terminal owns Pi: the chip reads the model, and says where it is changed */
  readOnly?: boolean;
  /** after a pick: the focus goes back to the message box, not the chip */
  onPicked?: () => void;
  /** a key outside the chip asked for the picker (Ctrl+L, DS §6.1): each new value opens it once */
  openRequest?: number;
}

/** One entry of `get_available_models`, cut to what a row says of it. */
export interface PickerModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  images: boolean;
  contextWindow: number | null;
}

interface ModelGroup {
  provider: string;
  models: PickerModel[];
}

/** How far from a screen edge the popover keeps, and how many rows PageUp/PageDown move. */
const EDGE = 8;
const PAGE = 8;

const text = (value: unknown): string | null => typeof value === "string" ? value : null;

/** Pi's model list, cut to what a row says; an entry without an id is left out. */
export function piModels(data: unknown): PickerModel[] {
  const list = (data as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const model = entry as Record<string, unknown>;
    const id = text(model["id"]);
    if (id === null) return [];
    const window = model["contextWindow"];
    const input = Array.isArray(model["input"]) ? model["input"] : [];
    return [{
      provider: text(model["provider"]) ?? "",
      id,
      name: text(model["name"]) ?? id,
      reasoning: model["reasoning"] === true,
      images: input.includes("image"),
      contextWindow: typeof window === "number" && window > 0 ? window : null,
    }];
  });
}

/** The providers in the order Pi listed them (it lists them together), each with what a search keeps of it. */
export function groupModels(models: readonly PickerModel[], query: string): ModelGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  const groups: ModelGroup[] = [];
  for (const model of models) {
    if (needle !== "" && !`${model.name} ${model.id}`.toLocaleLowerCase().includes(needle)) continue;
    const last = groups.at(-1);
    if (last?.provider === model.provider) last.models.push(model);
    else groups.push({ provider: model.provider, models: [model] });
  }
  return groups;
}

const keyOf = (model: PickerModel): string => `${model.provider}:${model.id}`;
const refusal = (error: unknown): string => error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error);

export function PiModelPicker({ label, current, piRpc, disabled, readOnly, onPicked, openRequest = 0 }: PiModelPickerProps) {
  const t = useT();
  const sheet = useMediaQuery(SHEET_QUERY);
  const listId = useId();
  const titleId = useId();
  const chipRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** a pick closed the picker: the focus goes to the message box, not back to the chip */
  const toBox = useRef(false);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [models, setModels] = useState<PickerModel[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<{ key: string; text: string } | null>(null);
  const trap = useFocusTrap<HTMLDivElement>(open && sheet, { initialFocus: searchRef, shouldRestore: () => !toBox.current });

  const groups = groupModels(models ?? [], query);
  const rows = groups.flatMap((group) => group.models);

  const dismiss = useCallback((): void => {
    setOpen(false);
    toBox.current = false;
  }, []);

  // a close the user aimed at the picker itself gives the chip its focus back; one a Tab away
  // caused (dismiss) leaves the focus where the keyboard put it
  const close = useCallback((): void => {
    dismiss();
    chipRef.current?.focus({ preventScroll: true });
  }, [dismiss]);

  const load = useCallback((): void => {
    setModels(null);
    setLoadError(false);
    setQuery("");
    setActive(0);
    setSwitchError(null);
    void piRpc({ type: "get_available_models" }).then(
      (data) => setModels(piModels(data)),
      () => { setLoadError(true); setModels([]); },
    );
  }, [piRpc]);

  // the list is read on every open, never cached: a model added in the terminal is there next time
  useEffect(() => {
    if (open) load();
  }, [load, open]);

  // Ctrl+L opens the same picker the chip does, and only where the chip could be pressed
  const lastOpenRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === lastOpenRequest.current) return;
    lastOpenRequest.current = openRequest;
    if (openRequest > 0 && !disabled && !readOnly) setOpen(true);
  }, [disabled, openRequest, readOnly]);

  // the current model is where the list opens, and the field takes the focus and the typing
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open || models === null) return;
    const at = models.findIndex((model) => current !== null && model.provider === current.provider && model.id === current.id);
    setActive(Math.max(0, at));
  }, [current, models, open]);

  useEffect(() => {
    if (!open || rows.length === 0) return;
    document.getElementById?.(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId, open, rows.length]);

  // over the chip, right edges aligned, or under it when the screen ends above; Escape, a press
  // outside, a scroll of what holds the chip and a resize close it
  useLayoutEffect(() => {
    if (!open || sheet) return;
    const anchor = chipRef.current;
    const surface = surfaceRef.current;
    if (!anchor || !surface) return;
    if (!anchor.isConnected) { setOpen(false); return; }
    const rect = anchor.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = surface;
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
      if (surfaceRef.current?.contains(target) || chipRef.current?.contains(target)) return;
      close();
    };
    const onScroll = (event: Event): void => {
      if (surfaceRef.current?.contains(event.target as Node)) return;
      dismiss();
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [close, dismiss, open, sheet]);

  useSheetSwipe(trap, open && sheet ? close : null);
  useSheetHistory(open && sheet, close);

  const pick = async (model: PickerModel): Promise<void> => {
    if (switching !== null) return;
    const key = keyOf(model);
    setSwitching(key);
    setSwitchError(null);
    try {
      await piRpc({ type: "set_model", provider: model.provider, modelId: model.id });
      toBox.current = true;
      setOpen(false);
      onPicked?.();
    } catch (error) {
      // the list stays open on the row it was about; the chip still draws the model Pi kept
      setSwitchError({ key, text: t("Couldn't switch: {reason}", { reason: refusal(error) }) });
    } finally {
      setSwitching(null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (rows.length === 0) return;
    const last = rows.length - 1;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(last, index + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
    else if (event.key === "PageDown") { event.preventDefault(); setActive((index) => Math.min(last, index + PAGE)); }
    else if (event.key === "PageUp") { event.preventDefault(); setActive((index) => Math.max(0, index - PAGE)); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(last); }
    else if (event.key === "Enter") {
      event.preventDefault();
      const model = rows[active];
      if (model !== undefined) void pick(model);
    }
  };

  const search = (
    <input
      ref={searchRef}
      className="input pi-picker-search"
      type="search"
      role="combobox"
      aria-expanded={open}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={rows.length > 0 ? `${listId}-${active}` : undefined}
      aria-label={t("Search models")}
      placeholder={t("Search models…")}
      value={query}
      onChange={(event) => { setQuery(event.target.value); setActive(0); setSwitchError(null); }}
    />
  );

  const list = (
    <>
      {loadError && (
        <p className="pi-picker-note" role="alert">
          {t("Couldn't load models")}{" "}
          <button type="button" className="btn pi-picker-retry" onClick={load}>{t("Try again")}</button>
        </p>
      )}
      {!loadError && models === null && (
        <div className="pi-picker-loading">
          <span className="visually-hidden" role="status">{t("Loading…")}</span>
          <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
        </div>
      )}
      {!loadError && models !== null && models.length === 0 && (
        <p className="pi-picker-note">{t("No models available. Sign in to a provider in Pi with /login.")}</p>
      )}
      {!loadError && models !== null && models.length > 0 && rows.length === 0 && (
        <p className="pi-picker-note">{t("No model matches \"{query}\"", { query: query.trim() })}</p>
      )}
      {!loadError && rows.length > 0 && (
        <div id={listId} className="pi-picker-list" role="listbox" aria-label={t("Model")} aria-busy={switching !== null || undefined}>
          {groups.map((group) => (
            <div key={group.provider} className="pi-picker-group" role="group" aria-label={group.provider}>
              <div className="menu-heading" aria-hidden="true">{group.provider}</div>
              {group.models.map((model) => {
                const key = keyOf(model);
                const index = rows.indexOf(model);
                const selected = current !== null && model.provider === current.provider && model.id === current.id;
                const meta = [
                  model.contextWindow === null ? null : t("{size} context", { size: formatTokens(model.contextWindow) }),
                  model.reasoning ? t("thinking") : null,
                  model.images ? t("images") : null,
                ].filter((part) => part !== null).join(" · ");
                return (
                  <div
                    key={key}
                    id={`${listId}-${index}`}
                    className="pi-picker-row"
                    role="option"
                    aria-selected={selected}
                    data-active={index === active || undefined}
                    onPointerEnter={() => setActive(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void pick(model)}
                  >
                    <span className="pi-picker-check" aria-hidden="true">{selected ? <Check /> : null}</span>
                    <span className="pi-picker-text">
                      <span className="pi-picker-name">{model.name}</span>
                      {meta !== "" && <span className="pi-picker-meta">{meta}</span>}
                      {switchError?.key === key && <span className="pi-picker-error" role="alert">{switchError.text}</span>}
                    </span>
                    {switching === key && <LoaderCircle className="pi-picker-busy" aria-hidden="true" />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </>
  );

  // a finger holds the sheet from its head; a press on the scrim or the X closes it, as Back does
  const onScrim = (event: MouseEvent<HTMLDivElement>): void => { if (event.target === event.currentTarget) close(); };
  const surface = sheet
    ? <div className="modal-scrim" onMouseDown={onScrim}>
      <div ref={trap} className="modal pi-picker-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <header className="modal-header">
          <h2 className="modal-title" id={titleId}>{t("Model")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={close}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          {search}
          {list}
        </div>
      </div>
    </div>
    : <div
      ref={surfaceRef}
      className="menu pi-picker"
      role="dialog"
      aria-label={t("Model")}
      style={place === null ? { left: 0, top: 0, visibility: "hidden" } : { left: place.left, top: place.top }}
      onKeyDown={onKeyDown}
      // a Tab out of it leaves the popover behind: it goes, and the focus stays where the keyboard put it
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next !== null && (surfaceRef.current?.contains(next) === true || chipRef.current?.contains(next) === true)) return;
        dismiss();
      }}
    >
      {search}
      {list}
    </div>;

  return (
    <span className="pi-model">
      <button
        ref={chipRef}
        type="button"
        className="pi-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-disabled={readOnly || undefined}
        disabled={disabled}
        title={readOnly ? `${t("Model: {name}", { name: label })} · ${t("Change it in the terminal")}` : t("Model: {name}", { name: label })}
        onClick={() => { if (open) close(); else if (!readOnly && !disabled) { toBox.current = false; setPlace(null); setOpen(true); } }}
      >
        <span className="pi-chip-name">{label}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && createPortal(surface, document.body)}
    </span>
  );
}
