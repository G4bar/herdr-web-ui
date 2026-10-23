import { describe, expect, it } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PiNativeNotice } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PiNoticeRows, RuntimeNoticeRow } from "./ChatView.tsx";

const render = (children: ReactNode): string => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

const notice = (over: Partial<PiNativeNotice> & { id: string }): PiNativeNotice => ({ type: "info", message: "Command blocked", ...over });

describe("Pi's notify rows", () => {
  it("draws one quiet line per notice, in the order they arrived, each type marked", () => {
    const notices = [notice({ id: "n1" }), notice({ id: "n2", type: "warning", message: "Stash is dirty" }), notice({ id: "n3", type: "error", message: "Compaction failed" })];
    const html = render(createElement(PiNoticeRows, { notices }));

    expect(html.match(/class="chat-note"/g)).toHaveLength(3);
    expect(html).toContain('data-notice="info"');
    expect(html).toContain('data-notice="warning"');
    expect(html).toContain('data-notice="error"');
    // the extension's own words, verbatim
    expect(html).toContain("Stash is dirty");
    expect(html).toContain("Compaction failed");
    // arrival order is the reading order
    expect(html.indexOf("Command blocked")).toBeLessThan(html.indexOf("Stash is dirty"));
    expect(html.indexOf("Stash is dirty")).toBeLessThan(html.indexOf("Compaction failed"));
  });

  it("is not a live region, and draws nothing for a Pi that notified nothing", () => {
    const html = render(createElement(PiNoticeRows, { notices: [notice({ id: "n1" })] }));

    expect(html).not.toContain("aria-live");
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(render(createElement(PiNoticeRows, { notices: [] }))).toBe("");
  });
});

describe("a custom message from the session file", () => {
  it("draws as the custom quiet card, its rail and label naming it, the text on request", () => {
    const html = render(createElement(RuntimeNoticeRow, {
      notice: { kind: "notice", text: "async-result:\nthe job is done", source: "async-result" },
      time: null,
    }));

    expect(html).toContain("chat-notice");
    expect(html).toContain("chat-notice-label");
    expect(html).toContain("Background result delivered");
    // the raw text is folded under the summary, as a runtime notice's own output
    expect(html).toContain("the job is done");
    expect(html).toContain("chat-notice-text");
  });
});
