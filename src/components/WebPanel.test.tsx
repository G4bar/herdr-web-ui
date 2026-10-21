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
});
