import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsProvider } from "../lib/settings.ts";
import { bashCard, ToolStop, ToolTail } from "./ToolBodies.tsx";

// the provider resolves the language from the browser, which react-dom's server render has not set up
function render(element: React.ReactElement): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: element }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("bashCard", () => {
  // the sentence a real pi session records under a command that exited non-zero
  it("takes pi's exit line out of the output and names the code", () => {
    const output = "ls: unrecognized option '--all'\nTry 'ls --help' for more information.\n\nCommand exited with code 1";
    expect(bashCard(output)).toEqual({ text: "ls: unrecognized option '--all'\nTry 'ls --help' for more information.", exit: 1 });
  });

  it("leaves an output that finished clean alone, and draws no exit 0", () => {
    expect(bashCard("12 pass\n0 fail")).toEqual({ text: "12 pass\n0 fail", exit: null });
    expect(bashCard("")).toEqual({ text: "", exit: null });
    expect(bashCard("done\n\nCommand exited with code 0")).toEqual({ text: "done", exit: null });
  });

  it("reads the line only at the end, so a command that prints one is not cut", () => {
    const output = "Command exited with code 2\nmore output";
    expect(bashCard(output)).toEqual({ text: output, exit: null });
  });
});

describe("ToolTail", () => {
  it("draws the last lines of a running call in a box of their own", () => {
    const markup = render(createElement(ToolTail, { lines: ["line one", "line two"] }));
    expect(markup).toContain("chat-tool-tail");
    expect(markup).toContain("line one\nline two");
  });

  it("draws nothing where pi has said nothing yet", () => {
    expect(render(createElement(ToolTail, { lines: [] }))).toContain('<pre class="chat-tool-io chat-tool-tail"></pre>');
  });
});

describe("ToolStop", () => {
  it("is a ghost button that says Stop", () => {
    const markup = render(createElement(ToolStop, { onAbort: () => undefined }));
    expect(markup).toContain('class="btn btn-ghost chat-tool-stop"');
    expect(markup).toContain(">Stop<");
  });
});
