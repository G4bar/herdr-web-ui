import { isToolNarration, toolCallLabel } from "./toolVerbs.ts";

/** Narration owns the visible label; the verb and its object determine the row and the detail. */
export function workRowLabel(part: { name: string; input: string }, summary: string): { narration: boolean; verb: string | null; object: string; server?: string } {
  const call = toolCallLabel(part, summary);
  return {
    narration: isToolNarration(part, summary),
    verb: call?.verb ?? null,
    object: call?.object ?? summary,
    ...(call?.server === undefined ? {} : { server: call.server }),
  };
}
