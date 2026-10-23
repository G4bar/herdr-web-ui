/**
 * Session context (DS §4.10): what Pi loaded for this session — the context files the server read
 * from the pane's folder and its parents, and the skills, prompt templates and extension commands
 * `get_commands` reports over RPC. The list is a left tablist like Settings, and a phone shows the
 * list then the tab, as Settings does. Use puts a skill's or prompt's command in the message box
 * and closes; View closes and opens a context file in the file viewer. A Terminal-mode pane has no RPC, so it
 * gets the context files alone. There is no MCP status source, so that tab is not offered.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronRight, LoaderCircle, X } from "lucide-react";

import "./SessionContextDialog.css";

import { sendPiRpc } from "../lib/api.ts";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { useT } from "../lib/i18n.ts";
import { piCommandText, piResources, usePiResources, type PiCommand, type PiExtension } from "../lib/piResources.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";

export interface SessionContextDialogProps {
  paneId: string;
  /** the PC the pane is on */
  machineId: string;
  /** the pane's Pi is driven over RPC: only then are skills, prompts and extensions known */
  native: boolean;
  onClose: () => void;
  /** a context file's View: the file viewer opens it */
  onViewFile?: (path: string) => void;
  /** Use: the command goes into the message box */
  onUse: (text: string) => void;
}

type TabId = "files" | "skills" | "prompts" | "extensions";

const TABS: TabId[] = ["files", "skills", "prompts", "extensions"];

/** The sheet's own breakpoint (`.modal`, styles.css): under it the list and a tab take turns. */
const NARROW_QUERY = "(max-width: 640px)";

/** The search field appears once a list is longer than this (DS §4.10). */
const SEARCH_ABOVE = 8;

export function SessionContextDialog({ paneId, machineId, native, onClose, onViewFile, onUse }: SessionContextDialogProps) {
  const t = useT();
  const id = useId();
  const narrow = useMediaQuery(NARROW_QUERY);
  const read = usePiResources(paneId, native, machineId);
  const { skills, prompts, extensions } = piResources(read.commands ?? []);
  // a phone opens on the list; a wider dialog shows the list beside the first tab
  const [chosen, setChosen] = useState<TabId | null>(null);
  // a Terminal-mode pane has no RPC: its context files are all the dialog can show
  const tabs = useMemo(() => native ? TABS : TABS.slice(0, 1), [native]);
  const page = chosen ?? (narrow ? null : tabs[0]!);
  const [reloading, setReloading] = useState(false);
  const [query, setQuery] = useState("");
  const surface = useFocusTrap<HTMLElement>(true);
  useSheetSwipe(surface, reloading ? null : onClose);
  usePhoneSheetBack(() => { if (reloading) return false; onClose(); });
  const tabsRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const shown = useRef<TabId | null>(null);
  const label = (tab: TabId): string => tab === "files" ? t("Context files") : tab === "skills" ? t("Skills") : tab === "prompts" ? t("Prompts") : t("Extensions");
  const count = (tab: TabId): number | null => tab === "files" ? read.files?.length ?? null : read.commands === null ? null : tab === "skills" ? skills.length : tab === "prompts" ? prompts.length : extensions.length;
  const tab = (target: TabId): HTMLElement | null => tabsRef.current?.querySelector<HTMLElement>(`[data-ctx-tab="${target}"]`) ?? null;
  const open = (target: TabId): void => setChosen(target);
  const goBack = (): void => setChosen(null);

  // the first tab takes the focus when the dialog opens; a phone's step into a tab and back
  // returns it to that tab's row, as Settings does
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = page;
    if (before === null) tab(page ?? tabs[0]!)?.focus({ preventScroll: true });
    else if (before !== page && narrow) {
      if (page !== null) backRef.current?.focus();
      else tab(before)?.focus();
    }
  }, [page, narrow, tabs]);

  useEffect(() => { setQuery(""); }, [page]);

  const onTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const to = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length]!;
    tab(next)?.focus();
    if (!narrow) open(next);
  };

  // Reload asks Pi to reload its resources, then reads both sources again; a refusal still
  // re-reads, so the lists say what Pi holds now
  const reload = async (): Promise<void> => {
    if (reloading) return;
    setReloading(true);
    try {
      await sendPiRpc(paneId, { type: "prompt", message: "/reload" }, machineId);
    } catch { /* Pi refused: the lists are read again below, and say so if that fails too */ }
    setReloading(false);
    read.read();
  };

  // Escape is the dialog's while it is up, as every dialog's is
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (!reloading) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, reloading]);

  const use = (command: PiCommand): void => { onUse(piCommandText(command)); onClose(); };
  // View closes first: the file viewer would sit under the dialog, or behind its scrim
  const view = (path: string): void => { onClose(); onViewFile?.(path); };

  const matches = (command: PiCommand): boolean => {
    const wanted = query.trim().toLowerCase();
    return wanted === "" || command.name.toLowerCase().includes(wanted) || command.description.toLowerCase().includes(wanted);
  };

  const commandList = (kind: "skills" | "prompts"): ReactNode => {
    const list = (kind === "skills" ? skills : prompts).filter(matches);
    if (list.length === 0) {
      return (
        <div className="ctx-empty">
          <p>{t(kind === "skills" ? "No skills installed." : "No prompts.")}</p>
          {kind === "skills" && <p className="ctx-hint"><code>pi install &lt;package&gt;</code> {t("adds a package's skills.")}</p>}
        </div>
      );
    }
    return (
      <ul className="ctx-list">
        {list.map((command) => (
          <li key={command.name} className="ctx-row">
            <span className="ctx-copy">
              <span className="ctx-name">{command.name}</span>
              {command.description !== "" && <span className="ctx-desc">{command.description}</span>}
            </span>
            {command.scope !== null && <span className="pill">{command.scope}</span>}
            <button type="button" className="btn ctx-action" onClick={() => use(command)}>{t("Use")}</button>
          </li>
        ))}
      </ul>
    );
  };

  const body = (): ReactNode => {
    if (read.failed) {
      return (
        <p className="ctx-error" role="alert">
          {t("Couldn't read Pi's resources")}{" "}
          <button type="button" className="btn ctx-action" onClick={read.read}>{t("Try again")}</button>
        </p>
      );
    }
    if (read.files === null || (native && read.commands === null)) {
      return <p className="ctx-note" role="status">{t("Reading what Pi loaded…")}</p>;
    }
    switch (page) {
      case "files":
        return read.files.length === 0
          ? <p className="ctx-note">{t("AGENTS.md not found in this folder or above.")}</p>
          : <>
            <p className="ctx-note">{t("Pi adds these to every request.")}</p>
            <ul className="ctx-list">
              {read.files.map((file) => (
                <li key={file.path} className="ctx-row">
                  <span className="ctx-copy"><span className="ctx-path">{file.path}</span></span>
                  <span className="pill">{file.scope}</span>
                  <span className="ctx-size">{formatBytes(file.size)}</span>
                  {onViewFile !== undefined && <button type="button" className="btn ctx-action" onClick={() => view(file.path)}>{t("View")}</button>}
                </li>
              ))}
            </ul>
          </>;
      case "skills":
      case "prompts": {
        const long = (page === "skills" ? skills : prompts).length > SEARCH_ABOVE;
        return <>
          {long && <input className="input ctx-search" type="search" aria-label={t(page === "skills" ? "Search skills" : "Search prompts")} placeholder={t(page === "skills" ? "Search skills…" : "Search prompts…")} value={query} onChange={(event) => setQuery(event.target.value)} />}
          {commandList(page)}
        </>;
      }
      case "extensions":
        return extensions.length === 0
          ? <p className="ctx-note">{t("No extensions.")}</p>
          : <ul className="ctx-list">
            {extensions.map((extension: PiExtension) => (
              <li key={extension.name} className="ctx-row ctx-extension">
                <span className="ctx-copy">
                  <span className="ctx-name">{extension.name}</span>
                  {extension.scope !== null && <span className="ctx-desc">{extension.scope}</span>}
                </span>
                <span className="ctx-commands">{extension.commands.map((name) => <span key={name} className="pill">/{name}</span>)}</span>
              </li>
            ))}
          </ul>;
    }
  };

  const titleId = `${id}-title`;
  const onScrim = (event: MouseEvent<HTMLDivElement>): void => { if (event.target === event.currentTarget && !reloading) onClose(); };
  const listShown = !narrow || page === null;

  return createPortal(
    <div className="modal-scrim" onMouseDown={onScrim}>
      <section ref={surface} className="modal ctx-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal-header ctx-header">
          {(narrow && page !== null) && <button type="button" ref={backRef} className="icon-button" aria-label={t("Back to session context")} onClick={goBack}><ArrowLeft aria-hidden="true" /></button>}
          <h2 className="modal-title" id={titleId}>{narrow && page !== null ? label(page) : t("Session context")}</h2>
          {native && (
            <button type="button" className="btn ctx-reload" disabled={reloading} onClick={() => void reload()}>
              {reloading && <LoaderCircle className="ctx-busy" aria-hidden="true" />}
              {t("Reload")}
            </button>
          )}
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {listShown && (
          <nav className="ctx-nav">
            <div ref={tabsRef} className="ctx-tabs" role="tablist" aria-orientation="vertical" aria-label={t("Session context")}>
              {tabs.map((target, index) => (
                <button key={target} type="button" role="tab" className="ctx-tab" data-ctx-tab={target} aria-selected={page === target} aria-controls={page === target ? `${id}-panel` : undefined} tabIndex={(page ?? tabs[0]) === target ? 0 : -1} onClick={() => open(target)} onKeyDown={(event) => onTabKey(event, index)}>
                  <span>{label(target)}{count(target) === null ? "" : ` (${count(target)})`}</span>
                  <ChevronRight className="ctx-tab-chevron" aria-hidden="true" />
                </button>
              ))}
            </div>
          </nav>
        )}
        {page !== null && <div id={`${id}-panel`} className="modal-body ctx-body" role="tabpanel" aria-label={label(page)}>{body()}</div>}
      </section>
    </div>,
    document.body,
  );
}
