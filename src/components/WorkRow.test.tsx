import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsProvider } from "../lib/settings.ts";
import type { ToolPart } from "../lib/workBlocks.ts";
import { WorkRow } from "./ChatView.tsx";

/** The last call of a turn that returned nothing: `output` is "" whether the result was empty or never came. */
const call = (extra: Partial<ToolPart> = {}): ToolPart => ({ kind: "tool", name: "bash", summary: "bun test", input: '{"command":"bun test"}', output: "", ...extra });

const render = (part: ToolPart, live: boolean): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(WorkRow, { paneId: "p1", part, stateKey: "tool:0", live, waiting: false, last: true, expandRows: false }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

const renderOpened = (part: ToolPart): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(WorkRow, { paneId: "p1", part, stateKey: "tool:0", live: false, waiting: false, last: true, expandRows: true }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("WorkRow", () => {
  it("does not call a finished call stopped when only its output is empty", () => {
    expect(render(call(), false)).not.toContain("stopped");
  });

  it("stops a finished call the transcript says got no result", () => {
    expect(render(call({ result_missing: true }), false)).toContain("stopped");
  });

  it("says Running… for a call without a result while the turn runs", () => {
    expect(render(call(), true)).toContain("Running…");
    expect(render(call({ result_missing: true }), true)).toContain("Running…");
  });

  it("opens a pi read as the file it gave back, not as its input and output", () => {
    const markup = renderOpened({ kind: "tool", name: "read", summary: "src/a.ts", input: '{"path":"src/a.ts"}', output: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") });
    expect(markup).toContain("chat-tool-file-body");
    expect(markup).toContain("Show all 12 lines");
    expect(markup).not.toContain('data-line="11"');
    expect(markup).not.toContain("chat-tool-output");
  });

  it("tints the message of a failed edit, and leaves a failed bash output plain", () => {
    expect(renderOpened(call({ name: "edit", summary: "src/a.ts", input: '{"path":"src/a.ts","edits":[]}', output: "Couldn't find the text", error: true }))).toContain("chat-tool-io is-failed");
    expect(renderOpened(call({ output: "boom", error: true }))).not.toContain("chat-tool-io is-failed");
  });

  // a codemode call's arguments are the script itself; the calls it ran are on its result
  it("opens a codemode script as its code block, with the calls it ran under its output", () => {
    const markup = renderOpened({ kind: "tool", name: "codemode", summary: "codemode", input: JSON.stringify({ code: "const a = await tools.read({ path: 'src/a.ts' });\nreturn a;" }), output: "Script completed\nWall time 0.4 seconds\nOutput:\nsrc/a.ts",
      nested_calls: [{ name: "read", summary: "src/a.ts" }] });
    expect(markup).toContain('class="markdown-code"');
    expect(markup).toContain("tools.read");
    expect(markup).toContain("Output");
    expect(markup).toContain("Calls (1)");
    expect(markup).toContain("Read");
  });

  it("draws an MCP call's arguments as the JSON it sent, and its answer as JSON", () => {
    const markup = renderOpened({ kind: "tool", name: "mcp__notes__add", summary: "notes.md", input: '{\n  "path": "notes.md"\n}', output: '{"id":7,"saved":true}' });
    expect(markup).toContain("Input");
    expect(markup).toContain('class="chat-json-key"');
    expect(markup).toContain('class="chat-json-literal">true');
  });

  it("draws pi's own cut as the way to the file, without the page's fetch", () => {
    const markup = renderOpened(call({ output: "a\n\n[Showing lines 1-2 of 900 (50.0KB limit). Full output: /tmp/pi-bash-abc.log]", output_ref: "r1" }));
    expect(markup).toContain("chat-tool-cut");
    expect(markup).toContain("/tmp/pi-bash-abc.log");
    expect(markup).not.toContain("chat-tool-more");
  });

  // the path in a command's output is the command's own word: the page's fetch still offers the rest
  it("offers the page's whole output over a cut a command printed itself", () => {
    const markup = renderOpened(call({ output: "ok\n\n[Showing lines 1-2 of 9 (50.0KB limit). Full output: /home/u/.ssh/id_rsa]", output_ref: "r1" }));
    expect(markup).not.toContain("chat-tool-cut");
    expect(markup).not.toContain("Open full output");
    expect(markup).toContain("chat-tool-more");
    expect(markup).toContain("Show the whole output");
  });

  it("draws a failed MCP call as the server's first line, the rest behind Details", () => {
    const markup = renderOpened({ kind: "tool", name: "mcp__notes__add", summary: "notes.md", input: '{}', output: "MCP error -32000: unknown tool\n\nstack line one\nstack line two", error: true });
    expect(markup).toContain("MCP error -32000: unknown tool");
    expect(markup).toContain("<summary>Details</summary>");
    expect(markup).toContain("stack line two");
  });
});
