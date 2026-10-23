/**
 * A native Pi pane's context ring, the cost beside it and the stats popover it opens (DS §4.5).
 * The ring draws `get_session_stats` as the bridge pushed it (`PiNativeState.stats`), never a read
 * of its own except when the popover opens: one `get_session_stats` refreshes the numbers, and a
 * refusal is the one sentence over the em-dashes' Try again. A desktop gets a popover over the
 * ring, a phone the modal primitive, which is a bottom sheet there. A pointer opens it by hovering
 * it for a moment, and it stays open while the pointer is inside; Escape closes it, as does a press
 * outside (WCAG 1.4.13). Only a native pane has one: a Pi the terminal owns keeps the composer's
 * own ring, and no other agent draws this.
 */
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { LoaderCircle, Minimize2, X } from "lucide-react";

import "./ContextPopover.css";

import type { PiNativeStats } from "../../shared/protocol.ts";
import { ApiError, type PiRpcCommand } from "../lib/api.ts";
import { formatTokens } from "../lib/compose.ts";
import { useT } from "../lib/i18n.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { useSheetHistory } from "../lib/sheetHistory.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";

export interface ContextPopoverProps {
  /** `get_session_stats` as the pane's live state holds it; null until Pi answers once */
  stats: PiNativeStats | null;
  /** the extensions' status lines, one per line under the numbers; `herdsman`'s own is the roster's */
  statuses?: Record<string, string>;
  /** one allowlisted command for the pane's Pi; a refusal throws with Pi's own sentence */
  piRpc: (command: PiRpcCommand) => Promise<unknown>;
  /** Pi is compacting: a short arc turns over the used one while it works (DS §4.1) */
  busy?: boolean;
}

/** How long the pointer rests on the ring before the popover opens, and how long it may leave it (DS §4.5). */
export const HOVER_OPEN_MS = 150;
export const HOVER_CLOSE_MS = 300;

/** The window Pi compacts against, and how much of it is used: what the ring and the bar fill with. */
export function usedPercent(stats: PiNativeStats | null): number | null {
  return stats?.contextUsage?.percent ?? null;
}

/** How full the ring draws (DS §4.5): the accent below 80% used, `--notice` from it, `--status-blocked` at 95%. */
export function ringLevel(percent: number | null): "ok" | "notice" | "full" {
  if (percent === null) return "ok";
  if (percent >= 95) return "full";
  if (percent >= 80) return "notice";
  return "ok";
}

/** The session's cost as the ring's inline text and the popover say it; an em-dash before Pi answers. */
export function costText(cost: number | null): string {
  return cost === null ? "—" : `$${cost.toFixed(2)}`;
}

const refusal = (error: unknown): string => error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error);

export function ContextPopover({ stats, statuses = {}, piRpc, busy = false }: ContextPopoverProps) {
  const t = useT();
  const sheet = useMediaQuery(SHEET_QUERY);
  const titleId = useId();
  const ringRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  /** the open `get_session_stats` was refused: the numbers stay as they were, with a way to ask again */
  const [loadFailed, setLoadFailed] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** the instructions field under Compact now (DS §4.5): null while folded away */
  const [instructions, setInstructions] = useState<string | null>(null);
  /** the pointer opened it: it closes when the pointer leaves both the ring and the popover */
  const hoverOpened = useRef(false);
  /** the ring is taking the focus back from a close: that focus must not open it again */
  const refocus = useRef(false);
  /** it was open when the press began, null with no press pending: the click that ends a press closes
   * what it opened instead of undoing it, and a key that never pressed reads the popover itself */
  const pressedOpen = useRef<boolean | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trap = useFocusTrap<HTMLDivElement>(open && sheet);

  const usage = stats?.contextUsage ?? null;
  const percent = usedPercent(stats);
  const level = ringLevel(percent);
  const cost = costText(stats === null ? null : stats.cost);
  const used = usage?.tokens ?? null;
  const label = percent === null ? t("Context") : t("Context: {percent}% used", { percent });
  const detail = usage === null ? "" : t("{used} of {window} tokens", { used: used === null ? "—" : formatTokens(used), window: formatTokens(usage.contextWindow) });
  const title = [label, detail, cost].filter((part) => part !== "").join(" · ");

  const clearTimer = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  /** the popover closes where it stands; a close the user aimed at it gives the ring its focus back */
  const dismiss = useCallback((): void => {
    clearTimer();
    hoverOpened.current = false;
    setOpen(false);
    setInstructions(null);
    setFailure(null);
  }, [clearTimer]);

  const close = useCallback((): void => {
    dismiss();
    const ring = ringRef.current;
    if (ring === null || document.activeElement === ring) return;
    refocus.current = true;
    ring.focus({ preventScroll: true });
  }, [dismiss]);

  // the numbers are re-read on every open, and the answer arrives as the pane's next pushed state
  const reload = useCallback((): void => {
    setLoadFailed(false);
    void piRpc({ type: "get_session_stats" }).catch(() => setLoadFailed(true));
  }, [piRpc]);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  useEffect(() => clearTimer, [clearTimer]);

  // a press outside, a scroll of what holds the ring and a resize close it
  useEffect(() => {
    if (!open || sheet) return;
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (popRef.current?.contains(target) || ringRef.current?.contains(target)) return;
      dismiss();
    };
    const onScroll = (event: Event): void => {
      if (popRef.current?.contains(event.target as Node)) return;
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
  }, [dismiss, open, sheet]);

  // Escape closes it whatever holds the focus in it, and does not also stop the pane's run (DS §6.1)
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, open]);

  useSheetSwipe(trap, open && sheet ? close : null);
  useSheetHistory(open && sheet, close);

  const hoverIn = (): void => {
    clearTimer();
    if (open) return;
    timer.current = setTimeout(() => {
      hoverOpened.current = true;
      setOpen(true);
    }, HOVER_OPEN_MS);
  };

  const hoverOut = (): void => {
    clearTimer();
    if (!open || !hoverOpened.current) return;
    timer.current = setTimeout(dismiss, HOVER_CLOSE_MS);
  };

  const compact = (): void => {
    if (compacting) return;
    setCompacting(true);
    setFailure(null);
    const text = instructions?.trim() ?? "";
    void piRpc(text === "" ? { type: "compact" } : { type: "compact", customInstructions: text }).then(
      () => setInstructions(null),
      (error: unknown) => setFailure(t("Couldn't compact: {reason}", { reason: refusal(error) })),
    ).finally(() => setCompacting(false));
  };

  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.max(0, Math.min(100, percent ?? 0));
  const statusLines = Object.entries(statuses).filter(([key, line]) => key !== "herdsman" && line.trim() !== "");

  const unsaid = stats === null || percent === null;
  const numbers = <>
    <div className="ctx-head">
      <span className="ctx-title" id={titleId}>{t("Context")}</span>
      <span className="ctx-amount">
        {used === null || usage === null ? "—" : formatTokens(used)} / {usage === null ? "—" : formatTokens(usage.contextWindow)}
      </span>
      <span className="ctx-percent">{percent === null ? "—" : `${percent}%`}</span>
    </div>
    <div className={`ctx-bar is-${level}`} aria-hidden="true"><span className="ctx-bar-fill" style={{ width: `${filled}%` }} /></div>
    {level === "full" && <p className="ctx-nearly">{t("Context is nearly full")}</p>}
    <dl className="ctx-rows">
      <div className="ctx-row">
        <dt>{t("Tokens")}</dt>
        <dd>{stats === null ? "—" : t("↑ {input} in · ↓ {output} out", { input: formatTokens(stats.tokens.input), output: formatTokens(stats.tokens.output) })}</dd>
      </div>
      <div className="ctx-row">
        <dt>{t("Cache")}</dt>
        <dd>{stats === null ? "—" : t("{read} read · {written} written", { read: formatTokens(stats.tokens.cacheRead), written: formatTokens(stats.tokens.cacheWrite) })}</dd>
      </div>
      <div className="ctx-row">
        <dt>{t("Cost")}</dt>
        <dd>{cost}</dd>
      </div>
    </dl>
    {loadFailed && (
      <p className="ctx-error" role="alert">
        {t("Couldn't read usage")}{" "}
        <button type="button" className="btn ctx-retry" onClick={reload}>{t("Try again")}</button>
      </p>
    )}
    {statusLines.map(([key, line]) => <p className="ctx-status" key={key}>{line}</p>)}
    <div className="ctx-actions">
      <button type="button" className="btn ctx-compact" onClick={compact} disabled={compacting}>
        {compacting ? <LoaderCircle className="ctx-busy" aria-hidden="true" /> : <Minimize2 aria-hidden="true" />}
        {t("Compact now")}
      </button>
      {instructions === null
        ? <button type="button" className="ctx-toggle" aria-expanded={false} onClick={() => setInstructions("")}>{t("Add instructions")}</button>
        : <input
          className="input ctx-instructions"
          aria-label={t("Add instructions")}
          placeholder={t("Add instructions")}
          value={instructions}
          autoFocus
          onChange={(event) => setInstructions(event.currentTarget.value)}
        />}
    </div>
    {failure !== null && <p className="ctx-error" role="alert">{failure}</p>}
  </>;

  // a finger holds the sheet from its head; a press on the scrim or the X closes it, as Back does
  const onScrim = (event: MouseEvent<HTMLDivElement>): void => { if (event.target === event.currentTarget) close(); };
  const surface = sheet
    ? <div className="modal-scrim" onMouseDown={onScrim}>
      <div ref={trap} className="modal ctx-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onPointerEnter={clearTimer} onPointerLeave={hoverOut}>
        <header className="modal-header">
          <h2 className="modal-title">{t("Context")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={close}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">{numbers}</div>
      </div>
    </div>
    : <div
      ref={popRef}
      className="menu ctx-popover"
      role="dialog"
      aria-labelledby={titleId}
      aria-busy={unsaid || undefined}
      onPointerEnter={clearTimer}
      onPointerLeave={hoverOut}
    >{numbers}</div>;

  return (
    <div className="ctx">
      <button
        ref={ringRef}
        type="button"
        className={`ctx-ring is-${level}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={title}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
        onFocus={() => {
          if (refocus.current) { refocus.current = false; return; }
          setOpen(true);
        }}
        onPointerDown={() => { pressedOpen.current = open; }}
        onClick={() => {
          const wasOpen = pressedOpen.current ?? open;
          pressedOpen.current = null;
          if (wasOpen) dismiss(); else setOpen(true);
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle className="ctx-ring-track" cx="8" cy="8" r={radius} />
          <circle className="ctx-ring-used" cx="8" cy="8" r={radius}
            strokeDasharray={`${circumference * filled / 100} ${circumference}`} transform="rotate(-90 8 8)" />
          {busy && <circle className="ctx-ring-busy" cx="8" cy="8" r={radius}
            strokeDasharray={`${circumference * 0.2} ${circumference}`} />}
        </svg>
      </button>
      <span className="ctx-cost">{cost}</span>
      {open && surface}
    </div>
  );
}
