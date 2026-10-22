import { useT } from "../lib/i18n.ts";

/** How an opened tool card ended: the four words DS §4.6 gives its head strip. */
export type ToolCardState = "running" | "done" | "failed" | "stopped";

/**
 * The head strip of an opened tool card: the tool's own id in mono, an MCP call's server as a
 * hairline pill, and the state word at the right over the state's tint. The word always says the
 * state; the tint is its second signal, and never the only one.
 */
export function ToolCardHead({ name, state, server }: { name: string; state: ToolCardState; server?: string }) {
  const t = useT();
  const word = state === "running" ? t("Running") : state === "failed" ? t("Failed") : state === "stopped" ? t("Stopped") : t("Done");
  return <div className={`tool-card-head is-${state}`}>
    <span className="tool-card-head-id">{name}</span>
    {server !== undefined && <span className="pill tool-card-head-server">{server}</span>}
    <span className="tool-card-head-state">{word}</span>
  </div>;
}
