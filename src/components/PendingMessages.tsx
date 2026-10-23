import { useRef, useState } from "react";
import { ArrowUp, Copy, Undo2, X } from "lucide-react";
import type { PendingMessageView } from "../lib/pendingMessages.ts";
import { clearPiQueue, queueRows, removeQueued, requeueCommands, type PiQueueRow } from "../lib/piNative.ts";
import type { PiRpcCommand } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { submitNote } from "../lib/compose.ts";
import { useT } from "../lib/i18n.ts";
import "./PendingMessages.css";

interface Props {
  messages: PendingMessageView[];
  active?: boolean;
  connected: boolean;
  /** the pane's agent, which names the input a refusal is about */
  agent?: string | null;
  blocked: boolean;
  /** a terminal command's peek has the pane: the rows stay, taking no input */
  inert?: boolean;
  unsaved: boolean;
  isBusy: (id: string) => boolean;
  onSendNow: (id: string) => Promise<void>;
  onDiscard: (id: string) => Promise<void>;
  /** a native pane's queue (DS §4.4): its rows, steers first, with Restore and Remove over Pi's own queue */
  queue?: PiQueueRow[];
  /** the pane's Pi: Clear queue, Restore and Remove take the queue out whole and put the kept rows back */
  piRpc?: (command: PiRpcCommand) => Promise<unknown>;
  /** Pi still runs, so a row put back goes in with its kind instead of as a new turn */
  streaming?: boolean;
  /** the texts a Restore took out, or a re-queue could not put back, land in the message box under the draft */
  onRestoreText?: (texts: readonly string[]) => void;
}

/** How long Clear queue asks before it acts: the same two-step as a row's Revoke (RD §Button). */
const CLEAR_ASK_MS = 4000;

/**
 * What a row says of its state. A held message waits for Send now only while this connection
 * holds it on the bridge: a copy restored from storage (another tab's live hold, or one from before
 * a reload) is reviewed first, since the tab that held it may still send it.
 */
export function pendingStatus(message: Pick<PendingMessageView, "state" | "error" | "serverOwned">, busy: boolean, t: (text: string) => string): string {
  if (busy) return t("Sending…");
  if (message.state === "queued") return t("Next turn");
  if (message.state === "held" && !message.error && message.serverOwned) return t("Waits for Send now");
  if (message.state === "uncertain") return t("Not confirmed. Check the terminal before sending again.");
  return t("Held message — review and send");
}

/** Pending text is separate from the transcript; Send now acts on its ID, never on its text. */
export function PendingMessages({ messages, active = true, connected, agent, blocked, inert = false, unsaved, isBusy, onSendNow, onDiscard, queue, piRpc, streaming = true, onRestoreText }: Props) {
  const t = useT();
  const activeRef = useRef(active);
  activeRef.current = active;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [clearAsk, setClearAsk] = useState(false);
  const [queueNote, setQueueNote] = useState<string | null>(null);
  const restoreFocus = (keyboard: boolean, target: HTMLButtonElement, stack: Element | null, owner: string | null): void => {
    const root = rootRef.current;
    if (!activeRef.current || !keyboard || target.isConnected || !stack?.isConnected || stack.getAttribute("data-pane-owner") !== owner) return;
    const next = root?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?? stack.querySelector<HTMLTextAreaElement>(".composer-text");
    next?.focus({ preventScroll: true });
  };
  /**
   * Pi holds no per-item queue (DS §4.4): the queue leaves whole with clear_queue, the rows the plan
   * keeps go back in delivery order, and the texts it takes out land in the message box. A re-queue
   * that fails takes the rest of its rows to the box with them, so no message is lost.
   */
  const takeQueue = (plan: (rows: PiQueueRow[]) => { back: PiQueueRow[]; box?: PiQueueRow[] }, keyboard: boolean, button: HTMLButtonElement): void => {
    if (piRpc === undefined || queueBusy) return;
    setQueueBusy(true);
    setQueueNote(null);
    void (async () => {
      let accepted = 0;
      let kept: PiQueueRow[] = [];
      let box: PiQueueRow[] = [];
      try {
        const rows = queueRows(await clearPiQueue(piRpc));
        const next = plan(rows);
        kept = next.back;
        box = next.box ?? [];
        for (const [index, command] of requeueCommands(kept, streaming).entries()) {
          try { await piRpc(command); accepted = index + 1; } catch { break; }
        }
      } catch {
        // nothing was taken out, so nothing is lost: the list stays as Pi last pushed it
        setQueueNote(t("Couldn't take Pi's queue. Try again."));
        return;
      } finally {
        setQueueBusy(false);
      }
      const texts = [...kept.slice(accepted), ...box].map((row) => row.text);
      if (texts.length > 0) onRestoreText?.(texts);
      if (keyboard) button.closest(".terminal-stack")?.querySelector<HTMLTextAreaElement>(".composer-text")?.focus({ preventScroll: true });
    })();
  };
  return <div ref={rootRef} className="pending-messages" inert={inert || undefined}>
    {queue !== undefined && <div className="pending-queue-head">
      <span className="pending-queue-title">{t("Held")} ({queue.length})</span>
      <button type="button" className="btn" disabled={piRpc === undefined || queueBusy || queue.length === 0}
        onClick={(event) => takeQueue((rows) => ({ back: [], box: rows }), event.detail === 0, event.currentTarget)}>
        {t("Restore all")}<kbd className="kbd" aria-hidden="true">Alt+↑</kbd>
      </button>
      <button type="button" className={clearAsk ? "btn btn-danger" : "btn"} disabled={piRpc === undefined || queueBusy || queue.length === 0}
        onClick={(event) => {
          if (!clearAsk) {
            setClearAsk(true);
            window.setTimeout(() => setClearAsk(false), CLEAR_ASK_MS);
            return;
          }
          setClearAsk(false);
          takeQueue(() => ({ back: [] }), event.detail === 0, event.currentTarget);
        }}>{t(clearAsk ? "Clear queue?" : "Clear queue")}</button>
    </div>}
    <ol className="pending-rows" aria-label={t("Queued messages")}>
      {unsaved && <li className="pending-message-note" role="status">{t("Queue could not be saved. Keep this tab open or copy the messages before reloading.")}</li>}
      {queue?.map((row, index) => {
        const label = t(row.kind === "steer" ? "Steer" : "Follow-up");
        return <li key={`${row.kind}:${index}:${row.text}`} className="pending-message pending-message-queue" data-kind={row.kind}>
          <span className={`pill pending-queue-kind${row.kind === "steer" ? " pending-queue-steer" : ""}`}>{label}</span>
          <span className="pending-queue-text">{row.text}</span>
          <div className="pending-message-meta">
            {/* Pi holds no per-item dequeue, so an index is all a row can name: a queue Pi changed behind it puts every row back whole */}
            <button type="button" className="icon-button pending-message-action pending-message-restore" aria-label={t("Restore to message box")} title={t("Restore to message box")}
              disabled={piRpc === undefined || queueBusy}
              onClick={(event) => takeQueue((rows) => {
                const taken = rows[index];
                return { back: removeQueued(rows, index), box: taken === undefined ? [] : [taken] };
              }, event.detail === 0, event.currentTarget)}><Undo2 aria-hidden="true" /></button>
            <button type="button" className="icon-button pending-message-action" aria-label={t("Remove")} title={t("Remove")}
              disabled={piRpc === undefined || queueBusy}
              onClick={(event) => takeQueue((rows) => ({ back: removeQueued(rows, index) }), event.detail === 0, event.currentTarget)}><X aria-hidden="true" /></button>
          </div>
        </li>;
      })}
      {messages.map((message) => {
        const busy = isBusy(message.id) || message.state === "sending";
        const uncertain = message.state === "uncertain";
        const status = pendingStatus(message, busy, t);
        return <li key={message.id} className="pending-message" data-state={message.state}>
          <div className="pending-message-bubble" aria-busy={busy || undefined}>{message.text}</div>
          <div className="pending-message-meta">
            <span className="pending-message-note" role="status">{status}</span>
            {!uncertain && <button type="button" className="icon-button pending-message-action pending-message-send"
              aria-label={`${t("Send now")}: ${message.text}`} aria-busy={busy || undefined} title={t("Send now")}
              disabled={!connected || blocked || busy} onClick={(event) => {
                const target = event.currentTarget, keyboard = event.detail === 0, stack = target.closest(".terminal-stack"), owner = stack?.getAttribute("data-pane-owner") ?? null;
                void onSendNow(message.id).finally(() => restoreFocus(keyboard, target, stack, owner));
              }}><ArrowUp aria-hidden="true" /><span>{t("Send now")}</span></button>}
            {uncertain && <button type="button" className="icon-button pending-message-action" aria-label={copied === message.id ? t("Copied") : t("Copy message")}
              title={t("Copy message")} onClick={(event) => {
                const text = event.currentTarget.closest(".pending-message")?.querySelector<HTMLElement>(".pending-message-bubble");
                void copyText(message.text, text).then((ok) => { if (ok) setCopied(message.id); });
              }}><Copy aria-hidden="true" /></button>}
            <button type="button" className="icon-button pending-message-action" aria-label={uncertain ? t("Discard saved copy") : t("Discard")}
              title={uncertain ? t("Discard saved copy") : t("Discard")} disabled={busy || message.serverOwned && !connected}
              onClick={(event) => {
                const target = event.currentTarget, keyboard = event.detail === 0, stack = target.closest(".terminal-stack"), owner = stack?.getAttribute("data-pane-owner") ?? null;
                void onDiscard(message.id).finally(() => restoreFocus(keyboard, target, stack, owner));
              }}><X aria-hidden="true" /></button>
          </div>
          {message.error && !uncertain && <p className="pending-message-note" role="status">{message.error.code === "still_open" ? message.error.message
            : (message.error.code === "input_draft" || message.error.code === "held_input" || message.error.code === "not_transmitted" || message.error.code === "rewind_dialog_open" || message.error.code === "first_message_unattended") ? submitNote(message.error.code, message.error.message, agent) : t("Not sent: {message}", { message: message.error.message })}</p>}
        </li>;
      })}
    </ol>
    {queueNote !== null && <p className="pending-message-note" role="status">{queueNote}</p>}
  </div>;
}
