import { expect, test } from "bun:test";
import type { ConversationPart } from "../shared/protocol.ts";
import { TOOL_OUTPUT_CHARS, trimOutput } from "./tool-output.ts";

test("a goal call's answer stays whole up to 16000 characters: its JSON, status and all, reaches the chat", () => {
  const objective = "o".repeat(3990);
  const answer = JSON.stringify({ goal: { objective, status: "complete", tokensUsed: 1, timeUsedSeconds: 2 } }, null, 2);
  expect(answer.length).toBeGreaterThan(TOOL_OUTPUT_CHARS);
  const goal: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: "update_goal", summary: "", input: "{}", output: "" };
  trimOutput(goal, answer, "ref");
  expect(goal.output).toBe(answer);
  expect(goal.output_ref).toBeUndefined();
  const other: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: "bash", summary: "", input: "{}", output: "" };
  trimOutput(other, answer, "ref");
  expect(other.output.endsWith("… trimmed")).toBe(true);
  expect(other.output_ref).toBe("ref");
});

test("reports true stored output size when a tool result was cut before reaching trimOutput", () => {
  const tool: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: "bash", summary: "", input: "{}", output: "" };
  const preview = "a".repeat(TOOL_OUTPUT_CHARS);
  trimOutput(tool, preview, "ref", 50_000);
  expect(tool.output).toBe(`${preview}\n… trimmed`);
  expect(tool.output_ref).toBe("ref");
  expect(tool.output_size).toBe(50_000);
});

test("finds pi's whole-output line without stalling on a long output", () => {
  // the tail alone is searched: an unterminated `[` used to backtrack over the whole text
  for (const body of ["\n".repeat(1_000_000), "[Showing lines ".repeat(100_000)]) {
    const tool: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: "bash", summary: "", input: "{}", output: "" };
    const started = performance.now();
    trimOutput(tool, body, "ref");
    expect(performance.now() - started).toBeLessThan(50);
  }
});

test("keeps the line naming pi's whole-output file past the page's own cut", () => {
  const tool: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: "bash", summary: "", input: "{}", output: "" };
  const body = `${"x".repeat(TOOL_OUTPUT_CHARS)}\n\n[Showing lines 450-715 of 715 (50.0KB limit). Full output: /tmp/pi-bash-2a93cf9321281ff6.log]\n\nCommand exited with code 1`;
  trimOutput(tool, body, "call-1");
  expect(tool.output.startsWith("x".repeat(100))).toBe(true);
  expect(tool.output.endsWith("\n… trimmed\n\n[Showing lines 450-715 of 715 (50.0KB limit). Full output: /tmp/pi-bash-2a93cf9321281ff6.log]")).toBe(true);
  expect(tool.output_ref).toBe("call-1");
});
