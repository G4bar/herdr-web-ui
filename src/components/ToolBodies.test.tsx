import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AskedAnswer } from "../lib/askQuestions.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AskedCard, bashCard, ToolFileBody, toolFileBody, ToolOutputCut, ToolStop, ToolTail } from "./ToolBodies.tsx";

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
    expect(bashCard(output)).toEqual({ text: "ls: unrecognized option '--all'\nTry 'ls --help' for more information.", exit: 1, cut: null });
  });

  it("leaves an output that finished clean alone, and draws no exit 0", () => {
    expect(bashCard("12 pass\n0 fail")).toEqual({ text: "12 pass\n0 fail", exit: null, cut: null });
    expect(bashCard("")).toEqual({ text: "", exit: null, cut: null });
    expect(bashCard("done\n\nCommand exited with code 0")).toEqual({ text: "done", exit: null, cut: null });
  });

  it("reads the line only at the end, so a command that prints one is not cut", () => {
    const output = "Command exited with code 2\nmore output";
    expect(bashCard(output)).toEqual({ text: output, exit: null, cut: null });
  });

  // the sentence a real pi session records under a command whose output it cut itself
  it("draws pi's own cut as the file holding the whole output, and its exit code apart", () => {
    const output = "line one\nline two\n\n[Showing lines 450-715 of 715 (50.0KB limit). Full output: /tmp/pi-bash-2a93cf9321281ff6.log]\n\nCommand exited with code 1";
    expect(bashCard(output)).toEqual({ text: "line one\nline two", exit: 1, cut: "/tmp/pi-bash-2a93cf9321281ff6.log" });
  });

  it("keeps the page's own cut off the text when the file names the rest", () => {
    expect(bashCard("head\n… trimmed\n\n[Showing last 4.0KB of line 715 (line is 8.2KB). Full output: /tmp/pi-bash-abc.log]"))
      .toEqual({ text: "head", exit: null, cut: "/tmp/pi-bash-abc.log" });
  });
});

describe("toolFileBody", () => {
  const call = (name: string, input: Record<string, unknown>, output = "", extra: { images?: boolean } = {}) =>
    toolFileBody({ name, input: JSON.stringify(input, null, 2), output, ...extra });

  it("reads a file's text and the lines a ranged read covered", () => {
    expect(call("read", { path: "src/a.ts", offset: 40, limit: 20 }, "a\nb")).toEqual({ path: "src/a.ts", range: "40–59", code: "a\nb", head: 10 });
  });

  it("draws no range for a read of a whole file", () => {
    expect(call("read", { path: "src/a.ts" }, "a")?.range).toBeNull();
    expect(call("read", { path: "src/a.ts", limit: 20 }, "a")?.range).toBe("1–20");
  });

  it("draws a picture pi read as its thumbnail alone, not the note the call recorded", () => {
    expect(call("read", { path: "shot.png" }, "Read image file [image/png]", { images: true })).toEqual({ path: "shot.png", range: null, code: "", head: 10 });
  });

  it("draws what a write put down, twenty lines at a time", () => {
    expect(call("write", { path: "src/b.ts", content: "x\ny" })).toEqual({ path: "src/b.ts", range: null, code: "x\ny", head: 20 });
  });

  it("leaves a failed call its own view: the agent's message is its body", () => {
    expect(toolFileBody({ name: "read", input: '{"path":"src/a.ts"}', output: "no such file", error: true })).toBeNull();
  });

  it("leaves every other call to its own rendering", () => {
    expect(call("Read", { file_path: "src/a.ts" }, "a")).toBeNull();
    expect(call("grep", { path: "src/a.ts", pattern: "x" }, "a")).toBeNull();
    expect(call("read", {}, "a")).toBeNull();
  });
});

describe("ToolFileBody", () => {
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  it("folds a long body to its head and says how many lines there are", () => {
    const markup = render(createElement(ToolFileBody, { path: "src/a.ts", range: "4–15", code: lines(12), head: 10 }));
    expect(markup).toContain("Lines 4–15");
    expect(markup).toContain('data-line="10"');
    expect(markup).not.toContain('data-line="11"');
    expect(markup).toContain("Show all 12 lines");
  });

  it("draws a short body whole, with nothing to unfold", () => {
    const markup = render(createElement(ToolFileBody, { path: "src/a.ts", range: null, code: lines(3), head: 10 }));
    expect(markup).toContain('data-line="3"');
    expect(markup).not.toContain("markdown-code-more");
  });

  it("draws the chip alone for a picture read", () => {
    const markup = render(createElement(ToolFileBody, { path: "shot.png", range: null, code: "", head: 10 }));
    expect(markup).toContain("shot.png");
    expect(markup).not.toContain("markdown-code");
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

describe("ToolOutputCut", () => {
  it("draws the words and opens the file holding the rest", () => {
    const markup = render(createElement(OpenFileContext.Provider, { value: () => undefined, children: createElement(ToolOutputCut, { path: "/tmp/pi-bash-abc.log" }) }));
    expect(markup).toContain("Output cut");
    expect(markup).toContain("Open full output");
    expect(markup).toContain('class="chat-tool-file-link"');
  });

  it("names the path where nothing here can open a file", () => {
    expect(render(createElement(ToolOutputCut, { path: "/tmp/pi-bash-abc.log" }))).toContain("/tmp/pi-bash-abc.log");
  });
});

describe("AskedCard", () => {
  const answered = (picks: string[], preview: string | null): AskedAnswer[] => [{
    question: { header: "Layout", question: "Which layout?", multi: false, recommended: null, options: [] },
    picks,
    preview,
  }];

  it("draws each question over the option that was picked, and the preview it showed", () => {
    const markup = render(createElement(AskedCard, { answers: answered(["Tabs"], "+--+\n| a |") }));
    expect(markup).toContain("Layout");
    expect(markup).toContain("Which layout?");
    expect(markup).toContain('class="pill chat-asked-pick"');
    expect(markup).toContain("Tabs");
    expect(markup).toContain("+--+\n| a |");
    expect(markup).not.toContain("No answer");
  });

  it("says no answer where nothing was picked", () => {
    const markup = render(createElement(AskedCard, { answers: answered([], null) }));
    expect(markup).toContain("No answer");
    expect(markup).not.toContain("chat-asked-picks");
  });
});
