/**
 * What an opened tool card draws of a Pi call body (DS §4.6). A call on a native pane runs while the
 * transcript still holds no result of it: its last output lines arrive as `PiNativeState.toolTails`,
 * keyed by the id the call has in the transcript, and the card draws them under a Stop until they
 * stop arriving.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n.ts";

/** What an opened card reads beyond its own part; ChatView provides it, a chat with no native Pi holds none. */
export interface PiToolCard {
  /** a running call's last output lines, by tool-call id; null when no Pi is driven over RPC here */
  tails: Record<string, string[]> | null;
  /** aborts the running turn: the card's Stop. Null where the chat has no Pi to command */
  abort: (() => void) | null;
}

export const NO_PI_TOOL_CARD: PiToolCard = { tails: null, abort: null };

export const PiToolCardContext = createContext<PiToolCard>(NO_PI_TOOL_CARD);

export function usePiToolCard(): PiToolCard {
  return useContext(PiToolCardContext);
}

/**
 * A bash call's output as its card shows it: pi ends a failed command's text with its own exit
 * line, which the card draws apart in the error tint, and a command that finished clean has none.
 */
export function bashCard(output: string): { text: string; exit: number | null } {
  const match = /\n*Command exited with code (\d+)\s*$/.exec(output);
  if (match === null) return { text: output, exit: null };
  const code = Number(match[1]);
  return { text: output.slice(0, match.index).replace(/\n+$/, ""), exit: code > 0 ? code : null };
}

/**
 * The lines of a call still running, as they arrive. The box follows the newest line until the
 * reader scrolls away from it, and stays where they left it after that.
 */
export function ToolTail({ lines }: { lines: readonly string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    const box = ref.current;
    if (box !== null && following) box.scrollTop = box.scrollHeight;
  }, [lines, following]);
  return <pre className="chat-tool-io chat-tool-tail" ref={ref} onScroll={(event) => {
    const box = event.currentTarget;
    setFollowing(box.scrollHeight - box.scrollTop - box.clientHeight < 8);
  }}>{lines.join("\n")}</pre>;
}

/** The Stop a running call's card offers: a ghost button, its words alone. */
export function ToolStop({ onAbort }: { onAbort: () => void }) {
  const t = useT();
  return <button type="button" className="btn btn-ghost chat-tool-stop" onClick={onAbort}>{t("Stop")}</button>;
}
