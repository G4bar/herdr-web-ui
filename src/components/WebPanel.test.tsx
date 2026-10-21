import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { WebPanel } from "./WebPanel.tsx";

// the language the dictionaries resolve against; bun's navigator has none of its own
const inEnglish = <T,>(render: () => T): T => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return render();
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

const html = (refresh: number) => inEnglish(() => renderToStaticMarkup(createElement(SettingsProvider, {
  children: createElement(WebPanel, { url: "http://localhost:19432/plan", refresh, onClose: () => {} }),
})));

/** The page rendered in a window of the given display modes: `standalone` is the installed app,
 * `browser` a plain tab (bun has no window, so the test brings its own). */
const inWindow = (modes: string[]): string => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: (query: string) => ({ matches: modes.some((mode) => query === `(display-mode: ${mode})`) }) } });
  try {
    return html(0);
  } finally {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
  }
};

describe("the page beside the pane", () => {
  it("loads the page again when it is pushed again, instead of keeping the frame it had", () => {
    // the first showing is the address as it came; each push of it names one the frame has not
    // loaded, so a page that changed since is fetched again instead of left as it was
    expect(html(0)).toContain('src="http://localhost:19432/plan"');
    expect(html(1)).toContain('src="http://localhost:19432/plan?herdr-panel-reload=1"');
    expect(html(2)).toContain('src="http://localhost:19432/plan?herdr-panel-reload=2"');
    // the panel still names the page itself, and its new-tab link is the address as the agent gave it
    expect(html(2)).toContain('href="http://localhost:19432/plan"');
    expect(html(2)).toContain("localhost:19432/plan");
  });

  it("opens the page in a new tab from a browser tab", () => {
    // a browser tab gets the browser's own new tab, as it always did
    const markup = inWindow(["browser"]);
    expect(markup).toContain('href="http://localhost:19432/plan"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('aria-label="Open in a new tab"');
    expect(markup).not.toContain('aria-label="Copy link"');
  });

  it("copies the address instead in the installed app's window, where a new tab leaves the app", () => {
    // on iOS a new tab from the installed app is Safari, outside the app: nothing is opened, the
    // address is copied for a browser instead, as the file viewer does
    const markup = inWindow(["standalone"]);
    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).not.toContain('target="_blank"');
    expect(markup).not.toContain('aria-label="Open in a new tab"');
    // the panel itself is untouched: the frame, its reload and its close stay
    expect(markup).toContain('src="http://localhost:19432/plan"');
    expect(markup).toContain('aria-label="Reload page"');
    expect(markup).toContain('aria-label="Close page"');
  });
});
