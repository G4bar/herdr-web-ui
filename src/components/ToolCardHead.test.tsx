import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsProvider } from "../lib/settings.ts";
import { ToolCardHead, type ToolCardState } from "./ToolCardHead.tsx";

const render = (state: ToolCardState, server?: string): string => {
  // the provider resolves the language from the browser, which react-dom's server render has not set up
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(ToolCardHead, { name: "read", state, ...(server === undefined ? {} : { server }) }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("ToolCardHead", () => {
  it("names the tool, then the state in words", () => {
    expect(render("running")).toContain('class="tool-card-head-id">read<');
    expect(render("running")).toContain('class="tool-card-head-state">Running<');
    expect(render("done")).toContain('class="tool-card-head-state">Done<');
    expect(render("failed")).toContain('class="tool-card-head-state">Failed<');
    expect(render("stopped")).toContain('class="tool-card-head-state">Stopped<');
  });

  it("tints the strip by the state, the word carrying it", () => {
    expect(render("running")).toContain('class="tool-card-head is-running"');
    expect(render("done")).toContain('class="tool-card-head is-done"');
    expect(render("failed")).toContain('class="tool-card-head is-failed"');
    expect(render("stopped")).toContain('class="tool-card-head is-stopped"');
  });

  it("puts an MCP call's server in a pill, and nothing when the call is no MCP tool", () => {
    expect(render("done", "github")).toContain('class="pill tool-card-head-server">github<');
    expect(render("done")).not.toContain("tool-card-head-server");
  });
});
