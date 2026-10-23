/**
 * Earlier sessions of a workspace's folder (#1314), from the workspace row's ⋯ menu and from
 * /resume in the chat: one agent's sessions as its own store lists them (GET /api/sessions/history),
 * newest first, each with its title (else its first prompt), its first prompt and the time it was
 * last touched. Resume starts the row's verified argv as the agent of a new tab in the workspace,
 * one at a time (lib/sessionHistory.ts inFlightGuard), so a double click starts one agent; a
 * session a pane of the workspace already shows is reached by selecting that pane in the browser
 * (herdr's focus stays where it is), and so is one Resume started a moment ago whose pane herdr has
 * not reported on yet (App's RecentResume records, `recent`): the list reopened in that window
 * offers Open, not a second Resume, for as long as the pane is listed without a session. A row
 * whose resume syntax is not verified is listed with no button. Escape, the scrim and Cancel close
 * it, Tab stays inside, arrows move along the rows, and focus returns to what opened it. The design follows the resume pickers of Codex CLI (`/resume`)
 * and Claude Code (`claude --resume`): one session per row, newest first, the first prompt as its
 * text and the time it was last touched beside it, Enter resuming; here in the worktree dialog's
 * row anatomy, with the agent above the rows in the New workspace dialog's picker (each agent with
 * its mark, no Shell entry), whose open list takes its own Escape.
 *
 * A Pi pane the chat drives over RPC (lib/piNative.ts, DS §4.9) resumes by switching that pane's
 * child to the row's session file (`switch_session`), not by starting a second agent; its Pi keys
 * are drawn as controls too: All|Named (Ctrl+N), Path (Ctrl+P), Recent|Relevance (Ctrl+S), and per
 * row Rename (Ctrl+R, the current session alone: another writer would need Pi's file) and a
 * two-step Delete (Ctrl+D, or Ctrl+Backspace on an empty search) that the bridge refuses for a
 * session a pane still runs. A row outside that pane's mode keeps today's Resume: a new tab.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import "./SessionHistory.css";
import { AgentPicker } from "./AgentPicker.tsx";
import type { AgentKind, HerdrPane, SessionHistoryAgent, SessionHistoryResponse, SessionHistoryRow, TabCreated, WorkspaceInfo } from "../../shared/protocol.ts";
import { ApiError, routeMissing, type PiRpcCommand } from "../lib/api.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { usePiNativeLane } from "../lib/piNative.ts";
import { inFlightGuard, paneShowingSession, resumeTabRequest, sessionHistoryAgent, sessionRowTime, standingResume, type RecentResume } from "../lib/sessionHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";

interface Props {
  workspace: WorkspaceInfo;
  /** the PC's panes: the one already showing a listed session is selected instead of a new tab */
  panes: readonly HerdrPane[];
  /** the agent listed first: the pane's, or the workspace row's */
  agent: SessionHistoryAgent;
  /** the Resumes of a moment ago whose panes have not reported their session yet (lib/useRecentResumes.ts) */
  recent?: readonly RecentResume[];
  onClose: () => void;
  /** browser selection only: herdr's focus stays where it is */
  onSelectPane: (paneId: string) => void;
  /** the tab herdr made for the row's session, which the caller records until herdr reports it */
  onResumed: (opened: TabCreated, session: { agent: SessionHistoryAgent; id: string }) => void;
  /** the pane the list was opened for: a native Pi pane of it resumes by switching its child (App names it) */
  nativePaneId?: string | null;
  /** one allowlisted command for that pane's Pi (App binds the pane id); absent means the pane is not native */
  onPiRpc?: (command: PiRpcCommand) => Promise<unknown>;
}

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

const NO_RECENT: readonly RecentResume[] = [];

export function SessionHistory({ workspace, panes, agent: firstAgent, recent = NO_RECENT, onClose, onSelectPane, onResumed, nativePaneId = null, onPiRpc }: Props) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const machineId = useMachineId();
  const { createTab, fetchAgentKinds, fetchSessionHistory, deleteSessionHistory } = useMachineApi();
  const lane = usePiNativeLane(machineId, nativePaneId);
  const native = onPiRpc === undefined ? null : lane.state;
  const currentPath = native?.sessionFile ?? null;
  const [agent, setAgent] = useState<SessionHistoryAgent>(firstAgent);
  const [kinds, setKinds] = useState<AgentKind[]>([]);
  const [answer, setAnswer] = useState<SessionHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [named, setNamed] = useState(false);
  const [showPath, setShowPath] = useState(false);
  const [sort, setSort] = useState<"recent" | "relevance">("recent");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** the name being typed for the current session, null while no row is being renamed */
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  /** bumped after a rename or a delete, which the store answers by listing again */
  const [reload, setReload] = useState(0);
  const guard = useRef(inFlightGuard());
  const surface = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const picker = useRef<HTMLButtonElement>(null);
  useSheetSwipe(surface, pending ? null : onClose);
  usePhoneSheetBack(() => { if (pending) return false; onClose(); });
  const opener = useRef<HTMLElement | null>(null);
  const placed = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // the dialog holds the focus from its first paint: an Escape pressed at once closes it rather
    // than going to the message box it was opened from
    picker.current?.focus({ preventScroll: true });
    placed.current = picker.current;
    return () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
  }, []);
  // the first row's button takes the focus once the rows are in; until then the agent field. Focus
  // the user moved meanwhile (Tab to Cancel, the field opened) stays where they put it
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (surface.current?.contains(active) && active !== placed.current) return;
      // an open agent list keeps the focus: its keys and Escape still belong to the list
      if (picker.current?.getAttribute("aria-expanded") === "true") return;
      const target = list.current?.querySelector<HTMLElement>("button:not(:disabled)") ?? picker.current;
      target?.focus();
      placed.current = target ?? null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [answer]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const active = document.activeElement;
      if (active && active !== document.body && !surface.current?.contains(active)) return;
      // the agent picker's open list takes this Escape: it closes the list, not the dialog
      if (active?.getAttribute("aria-expanded") === "true") return;
      // a row being renamed gives this Escape to the field, which keeps the dialog up
      if (renameDraft !== null) { event.stopPropagation(); event.preventDefault(); setRenameDraft(null); return; }
      event.stopPropagation();
      event.preventDefault();
      if (!pending) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pending, renameDraft]);
  useEffect(() => {
    let cancelled = false;
    fetchAgentKinds().then((next) => { if (!cancelled) setKinds(next); }, () => { /* the first agent alone is offered */ });
    return () => { cancelled = true; };
  }, [fetchAgentKinds]);
  useEffect(() => {
    let cancelled = false;
    setAnswer(null);
    setError(null);
    fetchSessionHistory(workspace.workspace_id, agent).then(
      (listing) => { if (!cancelled) setAnswer(listing); },
      (reason: unknown) => { if (!cancelled) setError(routeMissing(reason) ? t("This PC's bridge does not offer this yet") : said(reason)); },
    );
    return () => { cancelled = true; };
  }, [agent, fetchSessionHistory, reload, t, workspace.workspace_id]);
  const options = useMemo(() => {
    const listed = kinds.flatMap((kind) => { const kindName = sessionHistoryAgent(kind.kind); return kindName === null ? [] : [{ kind: kindName, label: kind.label }]; });
    return listed.some((option) => option.kind === firstAgent) ? listed : [{ kind: firstAgent, label: firstAgent }, ...listed];
  }, [firstAgent, kinds]);
  const agentLabel = options.find((option) => option.kind === agent)?.label ?? agent;
  const now = useMemo(() => Date.now(), [answer]);
  const resume = (row: SessionHistoryRow): void => {
    const request = resumeTabRequest(row, workspace.workspace_id, answer?.cwd ?? null);
    if (request === null) return;
    const started = guard.current.run(() => createTab(request));
    if (started === null) return;
    setPending(row.id);
    setError(null);
    started.then(
      (opened) => {
        if (opened.agent_started === false && opened.error) { setPending(null); setError(opened.error.message); return; }
        onResumed(opened, { agent, id: row.id });
      },
      (reason: unknown) => { setPending(null); setError(said(reason)); },
    );
  };
  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!pending && event.target === event.currentTarget) onClose();
  };
  /** The native pane's Pi switched to the row's session file: no second agent starts, the chat follows it. */
  const openNative = (row: SessionHistoryRow): void => {
    if (row.path === null || onPiRpc === undefined) return;
    const started = guard.current.run(() => onPiRpc({ type: "switch_session", sessionPath: row.path }));
    if (started === null) return;
    setPending(row.id);
    setError(null);
    started.then(
      () => { setPending(null); onClose(); },
      (reason: unknown) => { setPending(null); setError(said(reason)); },
    );
  };
  /** Rename the current session: Pi writes its own file, so no other row is offered one (PLAN D9). */
  const commitRename = async (): Promise<void> => {
    const name = (renameDraft ?? "").trim();
    if (name === "" || onPiRpc === undefined) return;
    setError(null);
    try {
      await onPiRpc({ type: "set_session_name", name });
      setRenameDraft(null);
      setReload((value) => value + 1);
    } catch (reason) {
      setError(said(reason));
    }
  };
  /** Delete one session file; the bridge refuses the current one and any a pane still runs, in its own words. */
  const removeRow = (row: SessionHistoryRow): void => {
    if (row.path === null) return;
    setPending(row.id);
    setError(null);
    deleteSessionHistory(row.path).then(
      () => { setPending(null); setConfirmDelete(null); setReload((value) => value + 1); },
      (reason: unknown) => { setPending(null); setConfirmDelete(null); setError(said(reason)); },
    );
  };
  /** The row the keyboard is on, its controls inside its own `<li>`: Ctrl+D acts on that one. */
  const focusedRowPath = (): string | null => {
    const active = document.activeElement;
    const item = active instanceof HTMLElement ? active.closest<HTMLElement>("li[data-path]") : null;
    return item?.dataset["path"] ?? null;
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Tab" && surface.current) {
      const stops = [...surface.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      if (stops.length === 0) return;
      const index = stops.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : (index < 0 || index === stops.length - 1 ? 0 : index + 1);
      event.preventDefault();
      stops[next]?.focus();
      return;
    }
    // Pi's keys of this list (DS §6.1), only while a native pane is what the list resumes into: a
    // rename field keeps its own keys, and a browser chord (Ctrl+W) is not ours to take
    if (native === null || renameDraft !== null || !event.ctrlKey || event.altKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === "n") { event.preventDefault(); setNamed((value) => !value); return; }
    if (key === "p") { event.preventDefault(); setShowPath((value) => !value); return; }
    if (key === "s") { event.preventDefault(); setSort((value) => (value === "recent" ? "relevance" : "recent")); return; }
    if (key === "r") {
      const row = visible.find((candidate) => candidate.path !== null && candidate.path === currentPath);
      if (row === undefined) return;
      event.preventDefault();
      setRenameDraft(row.title ?? "");
      return;
    }
    if (key !== "d" && !(key === "backspace" && query.trim() === "")) return;
    const path = focusedRowPath();
    const row = path === null ? undefined : visible.find((candidate) => candidate.path === path);
    // the current session is not deleted from under its own pane
    if (row === undefined || row.path === currentPath) return;
    event.preventDefault();
    if (confirmDelete === row.path) removeRow(row);
    else setConfirmDelete(row.path ?? null);
  };
  const moveAlongRows = (event: ReactKeyboardEvent<HTMLUListElement>): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !list.current) return;
    const buttons = [...list.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : event.key === "ArrowDown" ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1);
    event.preventDefault();
    buttons[next]?.focus();
  };
  const rows = answer?.sessions ?? null;
  /** The rows as the tools above them leave them: the All|Named filter, the search, and the sort. */
  const visible = useMemo(() => {
    if (rows === null) return [];
    const text = query.trim().toLowerCase();
    const matched = rows.flatMap((row) => {
      if (named && row.title === null) return [];
      if (text === "") return [{ row, at: 0 }];
      const haystack = [row.title, row.firstMessage, row.path, row.id].filter((value): value is string => value !== null && value !== "").join("\n").toLowerCase();
      const at = haystack.indexOf(text);
      return at < 0 ? [] : [{ row, at }];
    });
    return sort === "relevance" && text !== "" ? matched.sort((a, b) => a.at - b.at).map(({ row }) => row) : matched.map(({ row }) => row);
  }, [named, query, rows, sort]);
  const momentAgo = Date.now();
  return createPortal(
    <div className="modal-scrim" onMouseDown={closeFromScrim}>
      <div ref={surface} className="modal session-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Earlier sessions · {name}", { name: workspace.label })}</h2>
          <button type="button" className="icon-button" aria-label={t("Close session list")} disabled={pending !== null} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          <div className="field session-agent">
            <span className="field-label" id={`${id}-agent`}>{t("Agent")}</span>
            <AgentPicker ref={picker} agents={options} value={agent} shell={false} disabled={pending !== null} labelledBy={`${id}-agent`} onChange={(kind) => setAgent(kind as SessionHistoryAgent)} />
            {answer && <span className="field-hint session-folder">{t("Sessions started in {folder}", { folder: "\u0000" }).split("\u0000").map((part, index) => index === 0 ? <span key="before">{part}</span> : <span key="after"><code>{answer.cwd}</code>{part}</span>)}</span>}
          </div>
          {rows === null && !error ? (
            <p className="field-hint" role="status">{t("Reading sessions…")}</p>
          ) : rows && rows.length === 0 ? (
            <p className="field-hint session-empty">{t("No earlier {agent} sessions in this folder.", { agent: agentLabel })}</p>
          ) : rows && (
            <>
              {native !== null && (
                <div className="session-tools">
                  <input className="input session-search" type="search" value={query} aria-label={t("Search sessions…")} placeholder={t("Search sessions…")} onChange={(event) => setQuery(event.target.value)} />
                  <div className="segmented session-filter" role="group" aria-label={t("Filter")}>
                    <button type="button" aria-pressed={!named} onClick={() => setNamed(false)}>{t("All")}</button>
                    <button type="button" aria-pressed={named} onClick={() => setNamed(true)}>{t("Named")}</button>
                  </div>
                  <div className="segmented session-filter" role="group" aria-label={t("Sort")}>
                    <button type="button" aria-pressed={sort === "recent"} onClick={() => setSort("recent")}>{t("Recent")}</button>
                    <button type="button" aria-pressed={sort === "relevance"} onClick={() => setSort("relevance")}>{t("Relevance")}</button>
                  </div>
                  <button type="button" className="btn session-path-switch" aria-pressed={showPath} onClick={() => setShowPath((value) => !value)}>{t("Path")}</button>
                </div>
              )}
              {visible.length === 0 ? (
                <p className="field-hint session-empty">{t("No sessions match.")}</p>
              ) : (
            <ul ref={list} className="session-list" aria-label={t("Earlier sessions")} onKeyDown={moveAlongRows}>
              {visible.map((row) => {
                const title = row.title ?? row.firstMessage ?? row.id;
                const detail = row.title !== null ? row.firstMessage : null;
                const when = sessionRowTime(row, now, locale, t);
                // a pane that reports the session, else the pane of a Resume a moment ago; a record whose pane
                // the roster has not listed yet withholds Resume and offers nothing to open until it does
                const resumed = standingResume(recent, panes, machineId, workspace.workspace_id, agent, row.id, momentAgo);
                const shown = paneShowingSession(panes, workspace.workspace_id, agent, row.id) ?? (resumed === undefined ? undefined : panes.find((pane) => pane.pane_id === resumed.paneId && pane.workspace_id === workspace.workspace_id));
                const withheld = resumed !== undefined && shown === undefined;
                // a native pane opens the row by its own file; another caller still starts the verified argv
                const resumable = native !== null ? row.path !== null : row.resume !== null && row.resume.argv.length > 0;
                const current = native !== null && row.path !== null && row.path === currentPath;
                return (
                  <li key={row.id} data-path={row.path ?? undefined} className={`session-row${pending === row.id ? " is-pending" : ""}`} aria-label={when ? `${title} · ${when.label}` : title}>
                    <span className="session-copy">
                      <span className={`session-title${row.title === null && row.firstMessage === null ? " session-id" : ""}`}>{title}</span>
                      {detail !== null && <span className="session-detail">{detail}</span>}
                      {showPath && row.path !== null && <span className="session-path">{row.path}</span>}
                    </span>
                    <span className="session-meta">
                      {when && <time className="session-time" dateTime={row.updatedAt} title={when.title}>{when.label}</time>}
                      <span className="session-actions">
                        {current ? (
                          <>
                            <span className="pill">{t("Already open")}</span>
                            {renameDraft !== null ? (
                              <input className="input session-rename" value={renameDraft} aria-label={t("Rename")} autoFocus
                                onChange={(event) => setRenameDraft(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") { event.preventDefault(); void commitRename(); }
                                  if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); setRenameDraft(null); }
                                }} />
                            ) : (
                              <button type="button" className="btn session-action" disabled={pending !== null} onClick={() => setRenameDraft(native?.sessionName ?? row.title ?? "")}>{t("Rename")}</button>
                            )}
                          </>
                        ) : shown || withheld ? (
                          <>
                            <span className="pill">{t("Already open")}</span>
                            <button type="button" className="btn session-action" disabled={pending !== null || shown === undefined} aria-label={t("Open the pane showing {title}", { title })} onClick={() => { if (shown) onSelectPane(shown.pane_id); }}>{t("Open")}</button>
                          </>
                        ) : (
                          <>
                            {resumable && (
                              <button type="button" className="btn session-action" disabled={pending !== null} aria-label={t("Resume {title}", { title })} onClick={() => { if (native !== null) openNative(row); else resume(row); }}>{t("Resume")}</button>
                            )}
                            {native !== null && row.path !== null && (
                              <button type="button" className={`btn session-action${confirmDelete === row.path ? " btn-danger" : ""}`} disabled={pending !== null}
                                onClick={() => { if (confirmDelete === row.path) removeRow(row); else setConfirmDelete(row.path); }}>{confirmDelete === row.path ? t("Delete?") : t("Delete")}</button>
                            )}
                          </>
                        )}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
              )}
            </>
          )}
          {pending !== null && <p className="field-hint" role="status">{t("Resuming…")}</p>}
          {error && <p className="field-hint session-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={pending !== null} onClick={onClose}>{t("Cancel")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
