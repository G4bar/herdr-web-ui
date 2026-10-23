/**
 * The session tree (DS §4.9): Pi's own entry tree, as `get_tree` answers it. It is a view only —
 * Pi's RPC has no in-place navigation (PLAN D5) — so Enter, or a double click, on a message the
 * user sent forks from it: Pi restores that message and continues in a new session file, which the
 * server's registry follows (server/pi-native.ts). Rows, folds, filters and the search are
 * lib/piTree.ts's; this file draws them and owns Pi's tree keys (DS §6.1): Ctrl+D/T/U/L/A and
 * Ctrl+O filter, Ctrl/Alt+←/→ fold, Shift+T times.
 *
 * Pi lays its tree out as branch segments and the chat shows the path to the leaf first, so a fold
 * only ever hides a side branch. The row the conversation is on carries "you are here" and the
 * accent rail (DS §5.4); a fork needs Pi idle, so the keys wait while a turn runs.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Tag, X } from "lucide-react";

import "./SessionTree.css";

import { ApiError, sendPiRpc } from "../lib/api.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { forkNoteName, piForks } from "../lib/piFork.ts";
import { piNativeLanes } from "../lib/piNative.ts";
import { formatChatTimestamp } from "../lib/chatTimestamp.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { PI_TREE_FILTERS, piTreeFilterKey, piTreeRows, type PiTreeAnswer, type PiTreeFilter, type PiTreeNode, type PiTreeRow } from "../lib/piTree.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";

export interface SessionTreeProps {
  /** the pane whose Pi holds the tree */
  paneId: string;
  /** the PC the pane is on */
  machineId: string;
  /** a turn is running: Pi takes no fork mid-turn, so the keys wait for it */
  streaming: boolean;
  /** the forked message goes back into the message box */
  onFork: (text: string) => void;
  onClose: () => void;
}

/** An entry's id is Pi's own (`abc123`), so it is safe in an id attribute and a selector. */
const PLAIN_ID = /^[\w-]{1,80}$/u;

/**
 * Rows drawn at once. The tree is walked whole — that is one pass over the file — but a session of
 * thousands of entries cannot be laid out in one paint, so the list is a window around the selected
 * row and `Show more` widens it (DS §4.9: virtualised when long).
 */
const ROW_LIMIT = 200;

/** `get_tree`'s answer as the tree reads it: anything else is an empty tree, not a crash. */
function answerOf(data: unknown): PiTreeAnswer {
  const value = (data ?? {}) as { tree?: unknown; leafId?: unknown };
  return {
    tree: Array.isArray(value.tree) ? value.tree as PiTreeNode[] : [],
    leafId: typeof value.leafId === "string" ? value.leafId : null,
  };
}

/** Why a refused fork or read is put in one sentence: the server's own words where it has them. */
const refusal = (error: unknown): string =>
  error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error);

export function SessionTree({ paneId, machineId, streaming, onFork, onClose }: SessionTreeProps) {
  const t = useT();
  const locale = useLocale();
  const base = useId().replace(/:/gu, "");
  const listRef = useRef<HTMLDivElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: listRef });
  const [read, setRead] = useState<{ answer: PiTreeAnswer | null; failed: boolean }>({ answer: null, failed: false });
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<PiTreeFilter>("default");
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [times, setTimes] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [reach, setReach] = useState(ROW_LIMIT);
  const [forking, setForking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(onClose);

  // Pi answers the tree once each opening, and again when Try again asks
  useEffect(() => {
    let alive = true;
    setRead((current) => ({ ...current, failed: false }));
    void sendPiRpc(paneId, { type: "get_tree" }, machineId).then(
      (data) => { if (alive) setRead({ answer: answerOf(data), failed: false }); },
      () => { if (alive) setRead({ answer: null, failed: true }); },
    );
    return () => { alive = false; };
  }, [paneId, machineId, tick]);

  const rows = useMemo(() => piTreeRows(read.answer, { filter, query, folded }), [read.answer, filter, query, folded]);
  const selectedRow = rows.find((row) => row.id === selected) ?? null;
  // the window of rows on the page: it holds the selection, so a key press never acts on a row that is not drawn
  const selectedAt = rows.findIndex((row) => row.id === selected);
  const shownCount = Math.min(rows.length, reach);
  const start = selectedAt < 0
    ? Math.max(0, rows.length - shownCount)
    : Math.min(Math.max(0, selectedAt - shownCount + 1), rows.length - shownCount);
  const shown = rows.slice(start, start + shownCount);
  const hiddenAbove = start;
  const hiddenBelow = rows.length - start - shown.length;
  const showMore = useCallback(() => setReach((value) => value + ROW_LIMIT), []);

  // the newest message the user sent on the path the conversation is on: where `/fork` and a first
  // Enter land, and the only kind of row Pi forks from
  useEffect(() => {
    if (rows.length === 0) { setSelected(null); return; }
    if (selected !== null && rows.some((row) => row.id === selected)) return;
    const wanted = [...rows].reverse().find((row) => row.forking && row.active) ?? [...rows].reverse().find((row) => row.active) ?? rows[0]!;
    setSelected(wanted.id);
  }, [rows, selected]);

  // the selected row is the tree's active descendant: a keyboard move keeps it in view
  useEffect(() => {
    if (selected === null || !PLAIN_ID.test(selected)) return;
    listRef.current?.querySelector<HTMLElement>(`[data-row="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // a dialog's Escape is its own; a native modal over it (a confirm) keeps it, as every dialog does
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || nativeModalOver(surface.current)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, surface]);

  const filterLabel = (value: PiTreeFilter): string =>
    value === "default" ? t("Default")
      : value === "no-tools" ? t("No tools")
      : value === "user-only" ? t("User only")
      : value === "labeled-only" ? t("Labeled")
      : t("All");
  const roleLabel = (role: PiTreeRow["role"]): string =>
    role === "user" ? t("You") : role === "assistant" ? t("Pi") : role === "tool" ? t("Tool") : "";

  /** The fork a row offers: its own message back in the box, Pi continuing in another file. */
  const fork = useCallback((row: PiTreeRow): void => {
    if (!row.forking || streaming || forking) return;
    setForking(true);
    setError(null);
    // the file Pi holds now is the way back: read before the fork, since the child reports the new one
    const previous = piNativeLanes.get(paneStorageId(machineId, paneId)).state?.sessionFile ?? null;
    void sendPiRpc(paneId, { type: "fork", entryId: row.id }, machineId).then(
      (data) => {
        const text = (data as { text?: unknown } | null)?.text;
        // Pi hands the message back; a child that answers nothing keeps the row's own words
        const message = typeof text === "string" && text !== "" ? text : row.text;
        piForks.set(paneStorageId(machineId, paneId), { from: forkNoteName(message), sessionFile: previous });
        onFork(message);
        onClose();
      },
      (reason: unknown) => {
        setError(t("Couldn't fork: {reason}", { reason: refusal(reason) }));
        setForking(false);
      },
    );
  }, [forking, machineId, onClose, onFork, paneId, streaming, t]);

  const turnFold = (row: PiTreeRow): void => {
    if (!row.foldable) return;
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  };

  /** Ctrl/Alt+←/→: fold the segment, else walk to its parent, or unfold and step into it. */
  const step = (row: PiTreeRow, out: boolean): void => {
    const at = rows.findIndex((candidate) => candidate.id === row.id);
    if (out) {
      if (row.foldable && !row.folded) { turnFold(row); return; }
      const parent = rows.slice(0, at).reverse().find((candidate) => candidate.depth < row.depth);
      if (parent !== undefined) setSelected(parent.id);
      return;
    }
    if (row.foldable && row.folded) { turnFold(row); return; }
    const child = rows[at + 1];
    if (child !== undefined && child.depth > row.depth) setSelected(child.id);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const key = event.key;
    // DS §6.1 and Pi's own binds: Ctrl+D/T/U/L/A are the views, Ctrl+O (Shift+Ctrl+O backward) cycles
    if (event.ctrlKey && !event.altKey && !event.metaKey) {
      const next = piTreeFilterKey(filter, key, event.shiftKey);
      if (next !== null) {
        event.preventDefault();
        setFilter(next);
        return;
      }
    }
    if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && key.toLowerCase() === "t") {
      event.preventDefault();
      setTimes((value) => !value);
      return;
    }
    const at = rows.findIndex((row) => row.id === selected);
    const row = at < 0 ? null : rows[at]!;
    if ((event.ctrlKey || event.altKey) && (key === "ArrowLeft" || key === "ArrowRight")) {
      if (row === null) return;
      event.preventDefault();
      step(row, key === "ArrowLeft");
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      if (rows.length === 0) return;
      event.preventDefault();
      const from = at < 0 ? 0 : at;
      const to = Math.min(rows.length - 1, Math.max(0, from + (key === "ArrowDown" ? 1 : -1)));
      setSelected(rows[to]!.id);
      return;
    }
    if (key === "Enter" && row !== null) {
      event.preventDefault();
      fork(row);
    }
  };

  // a press on a row leaves the keyboard where it was: the tree's own keys act on the selection
  const select = (event: MouseEvent<HTMLDivElement>, row: PiTreeRow): void => {
    event.preventDefault();
    setSelected(row.id);
  };
  const onScrim = (event: MouseEvent<HTMLDivElement>): void => { if (event.target === event.currentTarget) onClose(); };

  const now = Date.now();
  const hint = streaming ? t("Pi is working. Fork when it finishes.")
    : selectedRow === null || !selectedRow.forking ? t("Fork from a message you sent")
    : null;

  return createPortal(
    <div className="modal-scrim" onMouseDown={onScrim}>
      <div ref={surface} className="modal pi-tree-dialog" role="dialog" aria-modal="true" aria-labelledby={`${base}-title`} tabIndex={-1} onKeyDown={onKeyDown}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${base}-title`}>{t("Session tree")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="pi-tree-tools">
          <div className="segmented pi-tree-filters" role="group" aria-label={t("Filter")}>
            {PI_TREE_FILTERS.map((value) => (
              <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{filterLabel(value)}</button>
            ))}
          </div>
          <input className="input pi-tree-search" type="search" value={query} aria-label={t("Filter")} placeholder={t("Filter…")}
            onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="modal-body pi-tree-body">
          {read.answer === null && !read.failed && <p className="pi-tree-empty" role="status">{t("Loading the session tree…")}</p>}
          {read.failed && <div className="pi-tree-empty">
            <p role="alert">{t("Couldn't read the session tree")}</p>
            <button type="button" className="btn" onClick={() => setTick((value) => value + 1)}>{t("Try again")}</button>
          </div>}
          {read.answer !== null && rows.length === 0 && <p className="pi-tree-empty">{query.trim() === "" ? t("Nothing to branch from yet.") : t("No entries match")}</p>}
          {rows.length > 0 && <>
            {hiddenAbove > 0 && <button type="button" className="pi-tree-load" onClick={showMore}>{t("Show {count} more", { count: hiddenAbove })}</button>}
            <div ref={listRef} className="pi-tree-list" role="tree" aria-label={t("Session tree")} tabIndex={0}
              aria-activedescendant={selected === null ? undefined : `${base}-row-${selected}`} aria-busy={forking}>
              {shown.map((row) => {
                const time = times ? formatChatTimestamp(row.ts, now, locale, t) : null;
                const guides = row.guides.map((guide, level) => <span key={level} className={guide ? "pi-tree-guide is-line" : "pi-tree-guide"} aria-hidden="true" />);
                return <div key={row.id} id={`${base}-row-${row.id}`} data-row={row.id} role="treeitem"
                  aria-level={row.depth + 1} aria-selected={selected === row.id}
                  {...(row.foldable ? { "aria-expanded": !row.folded } : {})}
                  className={`pi-tree-row${row.active ? " is-active" : ""}${selected === row.id ? " is-selected" : ""}`}
                  onClick={(event) => select(event, row)} onDoubleClick={() => fork(row)}>
                  {guides}
                  <span className="pi-tree-step">
                    {row.foldable && <button type="button" tabIndex={-1} className="pi-tree-caret" aria-label={row.folded ? t("Unfold") : t("Fold")}
                      onClick={(event) => { event.stopPropagation(); turnFold(row); }}>
                      {row.folded ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                    </button>}
                  </span>
                  <span className="pi-tree-role">{roleLabel(row.role)}</span>
                  <span className="pi-tree-text">{row.text}</span>
                  {row.folded && <span className="pi-tree-more">{t("({count} more)", { count: row.hidden })}</span>}
                  {row.label !== null && <span className="pill pi-tree-label"><Tag aria-hidden="true" />{row.label}</span>}
                  {row.current && <span className="pi-tree-here">{t("you are here")}</span>}
                  {time !== null && <span className="pi-tree-time" title={time.full}>{time.label}</span>}
                </div>;
              })}
            </div>
            {hiddenBelow > 0 && <button type="button" className="pi-tree-load" onClick={showMore}>{t("Show {count} more", { count: hiddenBelow })}</button>}
          </>}
        </div>
        <footer className="modal-footer pi-tree-footer">
          {error !== null && <p className="pi-tree-error" role="alert">{error}</p>}
          {hint !== null && <p className="pi-tree-hint">{hint}</p>}
          <p className="pi-tree-keys" aria-hidden="true">
            <span className="pi-tree-key"><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd>{t("Move")}</span>
            {hint === null && <span className="pi-tree-key"><kbd className="kbd">Enter</kbd>{t("Go here")}</span>}
            <span className="pi-tree-key"><kbd className="kbd">Ctrl/Alt+←→</kbd>{t("Fold")}</span>
            <span className="pi-tree-key"><kbd className="kbd">Shift+T</kbd>{t("Times")}</span>
          </p>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
