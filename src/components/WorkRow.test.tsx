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
});
