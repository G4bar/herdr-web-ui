/**
 * Scoped models (DS §4.11): the models Pi's own cycling walks, and the order it walks them in. The
 * rows are the pane's model list (`get_available_models`) grouped by provider, as the picker draws
 * it; a check puts a model in the cycle and the arrows order it. Save writes `enabledModels` to Pi's
 * settings file, whose entries are `provider/id`, the format Pi's own `--models` takes.
 *
 * A pattern the file holds that no row names (`claude*`) is written back as it was: the dialog only
 * rewrites the rows it shows, so a hand-written scope is never lost. Pi reads that file at startup,
 * so the note above the list says where a change is taken up.
 *
 * Pi's own keys live here (DS §6.1): Ctrl+A, Ctrl+X, Ctrl+P and Ctrl+S are handled inside this
 * dialog alone, so the browser never selects the page, prints it or saves it.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Check, X } from "lucide-react";

import "./ScopedModelsDialog.css";

import { ApiError, savePiSettings, type PiSettingsFile } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { groupModels, type PickerModel } from "./PiModelPicker.tsx";

export interface ScopedModelsDialogProps {
  /** the pane's model list, in Pi's order */
  models: readonly PickerModel[];
  /** the file's `enabledModels` in Pi's order; null when the file sets none, so every model cycles */
  scoped: readonly string[] | null;
  /** the PC whose Pi settings are written */
  machineId: string;
  /** the settings file as the server answered it after the write */
  onSaved: (file: PiSettingsFile) => void;
  onClose: () => void;
}

/** One model as Pi's settings file names it in `enabledModels`. */
const entryOf = (model: PickerModel): string => `${model.provider}/${model.id}`;

const refusal = (error: unknown): string => error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error);

export function ScopedModelsDialog({ models, scoped, machineId, onSaved, onClose }: ScopedModelsDialogProps) {
  const t = useT();
  const id = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  /** the cycle, in Pi's order; entries the rows do not name (a pattern) keep their place, untouched */
  const [order, setOrder] = useState<string[]>(() => scoped === null ? models.map(entryOf) : [...scoped]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** the provider Ctrl+P turns: the one whose model last took the focus */
  const provider = useRef(models[0]?.provider ?? "");
  const groups = groupModels(models, "");
  const known = new Set(models.map(entryOf));
  const kept = order.filter((model) => !known.has(model));

  const open = saving ? null : onClose;
  useSheetSwipe(surface, open);
  usePhoneSheetBack(() => { if (saving) return false; onClose(); });

  // Escape closes the dialog whatever holds the focus in it, and only while it can still be left
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      if (!saving) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, saving]);

  /** every model of one provider in, or all of them out */
  const turn = (provider: string): void => {
    const keys = models.filter((model) => model.provider === provider).map(entryOf);
    setOrder((current) => keys.every((key) => current.includes(key))
      ? current.filter((key) => !keys.includes(key))
      : [...current, ...keys.filter((key) => !current.includes(key))]);
  };

  /** one model up or down the cycle: the neighbour it trades places with is the next checked one */
  const move = (key: string, step: number): void => {
    setOrder((current) => {
      const at = current.indexOf(key);
      const to = at + step;
      if (at === -1 || to < 0 || to >= current.length) return current;
      const next = [...current];
      [next[at], next[to]] = [next[to]!, next[at]!];
      return next;
    });
  };

  /** every model in, and every row out: Ctrl+A and Ctrl+X, and the two buttons beside the footer */
  const enableAll = (): void => setOrder([...models.map(entryOf), ...kept]);
  const clearAll = (): void => setOrder(kept);

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const file = await savePiSettings({ enabledModels: order }, machineId);
      onSaved(file);
      onClose();
    } catch (reason: unknown) {
      setError(t("Couldn't change {setting}: {reason}", { setting: t("Scoped models"), reason: refusal(reason) }));
      setSaving(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    const key = event.key.toLocaleLowerCase();
    if (key === "a") { event.preventDefault(); enableAll(); }
    else if (key === "x") { event.preventDefault(); clearAll(); }
    else if (key === "p") { event.preventDefault(); turn(provider.current); }
    else if (key === "s") { event.preventDefault(); void save(); }
  };

  // a press on the scrim closes it; the sheet's grip and Back do too (DS §7)
  const onScrim = (event: MouseEvent<HTMLDivElement>): void => { if (event.target === event.currentTarget && !saving) onClose(); };

  return createPortal(
    <div className="modal-scrim" onMouseDown={onScrim}>
      <div ref={surface} className="modal scoped-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} onKeyDown={onKeyDown}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Scoped models")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose} disabled={saving}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          <p className="scoped-note">{t("A new Pi session starts with these. A running Pi reads them again with /reload.")}</p>
          {models.length === 0
            ? <p className="scoped-note">{t("No models available. Sign in to a provider in Pi with /login.")}</p>
            : <>
              <p className="scoped-note">{t("{scoped} of {total} in the cycle", { scoped: order.length - kept.length, total: models.length })}</p>
              <ul className="scoped-list">
                {groups.map((group) => {
                  const keys = group.models.map(entryOf);
                  const every = keys.every((key) => order.includes(key));
                  const name = group.provider === "" ? t("Other") : group.provider;
                  return (
                    <li key={group.provider} className="scoped-group">
                      <button type="button" className="scoped-provider" role="checkbox" aria-checked={every} aria-label={name} onClick={() => turn(group.provider)}>
                        <span className="scoped-box" aria-hidden="true">{every && <Check />}</span>
                        <span className="menu-heading">{name}</span>
                      </button>
                      <ul className="scoped-rows">
                        {group.models.map((model) => {
                          const key = entryOf(model);
                          const checked = order.includes(key);
                          const at = order.indexOf(key);
                          return (
                            <li key={key} className="scoped-row" onFocus={() => { provider.current = model.provider; }}
                              onKeyDown={(event) => {
                                if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                                event.preventDefault();
                                move(key, event.key === "ArrowUp" ? -1 : 1);
                              }}>
                              <input type="checkbox" checked={checked} aria-label={model.name} onChange={() => {
                                setOrder((current) => checked ? current.filter((entry) => entry !== key) : [...current, key]);
                              }} />
                              <span className="scoped-name">{model.name}</span>
                              <button type="button" className="icon-button scoped-move" aria-label={t("Move up")} disabled={!checked || at <= 0} onClick={() => move(key, -1)}><ArrowUp aria-hidden="true" /></button>
                              <button type="button" className="icon-button scoped-move" aria-label={t("Move down")} disabled={!checked || at === order.length - 1} onClick={() => move(key, 1)}><ArrowDown aria-hidden="true" /></button>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </>}
        </div>
        <footer className="modal-footer">
          <div className="scoped-all">
            <button type="button" className="btn" onClick={enableAll} disabled={saving}>{t("Enable all")}</button>
            <button type="button" className="btn" onClick={clearAll} disabled={saving}>{t("Clear all")}</button>
          </div>
          {error !== null && <p className="scoped-error" role="alert">{error}</p>}
          <button type="button" className="btn" onClick={onClose} disabled={saving}>{t("Cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving || models.length === 0}>{t("Save")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
