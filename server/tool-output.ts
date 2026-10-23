import type { ConversationPart } from "../shared/protocol.ts";

/** Past this a tool's output is cut in the page; the rest is fetched on request (toolOutput). */
export const TOOL_OUTPUT_CHARS = 4000;

/**
 * omo's goal calls answer with the goal as JSON the chat reads, its objective alone up to 4000
 * characters: cut at the usual length, a finished goal's answer lost its status.
 */
const WHOLE_OUTPUT_TOOLS = new Set(["create_goal", "update_goal", "get_goal"]);
const WHOLE_OUTPUT_CHARS = 16_000;

/**
 * pi's bash tool keeps a command's whole output in a file and ends the text it answers with the
 * line naming it. The page's own cut must not swallow that line: the card draws it as the way to
 * the file (`Output cut · Open full output`, DS §4.6), and it sits at the end of a text long
 * enough to be cut. Only that tail is searched: an unterminated `[` in a long output made a
 * whole-text `\n*[^]]*` match backtrack quadratically.
 */
const PI_FULL_OUTPUT = /\[Showing (?:lines|last)[^\]]*Full output: [^\]\n]+\]/g;
const PI_TAIL_CHARS = 1000;

/** Sets a tool part's output, cut to what a page carries, keeping what it takes to fetch the rest. */
export function trimOutput(tool: Extract<ConversationPart, { kind: "tool" }>, output: string, ref: string, fullSize?: number): void {
  const limit = WHOLE_OUTPUT_TOOLS.has(tool.name) ? WHOLE_OUTPUT_CHARS : TOOL_OUTPUT_CHARS;
  const size = fullSize ?? output.length;
  if (size <= limit) { tool.output = output; return; }
  const named = [...output.slice(-PI_TAIL_CHARS).matchAll(PI_FULL_OUTPUT)].at(-1)?.[0].trim();
  tool.output = `${output.slice(0, limit)}\n… trimmed${named === undefined ? "" : `\n\n${named}`}`;
  tool.output_ref = ref;
  tool.output_size = size;
}
