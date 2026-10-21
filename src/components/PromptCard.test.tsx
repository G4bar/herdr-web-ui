import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { InteractivePrompt } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PromptCard } from "./PromptCard.tsx";

const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });

/** A pi ask_user_question card: the screen's own fields, plus whatever the session's call added. */
const card = (fields: Partial<InteractivePrompt> = {}): InteractivePrompt => ({
  id: "p1",
  agent: "pi",
  kind: "question",
  title: "Layout",
  question: "Which layout should the settings page use?",
  body: null,
  options: [{ label: "Sidebar", description: "Vertical nav with a detail pane." }, { label: "Tabs", description: "Horizontal tabs at the top." }],
  multi_select: false,
  custom_option_index: 2,
  ...fields,
});

const render = (prompt: InteractivePrompt, typedAnswer: { option_index: number } | null = null) => renderToStaticMarkup(createElement(SettingsProvider, {
  children: createElement(PromptCard, { paneId: "pane-1", prompt, typedAnswer, onPromptChanged() {}, onAnswered() {} }),
}));

const text = (html: string) => html.replace(/<[^>]*>/g, "");

describe("the question card", () => {
  it("heads the card with its header, and with its title where no header came", () => {
    expect(render(card({ header: "Layout" }))).toContain("<h2>Layout</h2>");
    expect(render(card({ title: "Library" }))).toContain("<h2>Library</h2>");
  });

  it("says the question under the heading only when the heading is not the question", () => {
    // pi's heading already is the question: said once
    const once = render(card({ header: "Which layout should the settings page use?" }));
    expect(text(once).split("Which layout should the settings page use?").length - 1).toBe(1);
    expect(text(render(card({ header: "Layout" }))).split("Which layout should the settings page use?").length - 1).toBe(1);
  });

  it("tags the option the call recommends, by index, without moving or picking it", () => {
    const html = render(card({ recommended_index: 1 }));
    expect(html.split("Recommended").length - 1).toBe(1);
    expect(html.indexOf("Tabs")).toBeLessThan(html.indexOf("Recommended"));
    // not pre-selected: a row shows the tag, never the pick
    expect(html).not.toContain("is-checked");
    expect(html).not.toContain('type="radio"');
  });

  it("keeps the tag a label already spells out, once", () => {
    const options = [{ label: "Sidebar", description: null }, { label: "Tabs (Recommended)", description: null }];
    const html = render(card({ options }));
    expect(html.split("Recommended").length - 1).toBe(1);
    expect(html).toContain(">Tabs <span class=\"prompt-card-tag\">Recommended</span>");
  });

  it("picks a previewed question with radios, then submits", () => {
    const options = [{ label: "Sidebar", description: null, preview: "+---+---+\n| a | b |\n+---+---+" }, { label: "Tabs", description: null, preview: null }];
    const html = render(card({ options }));
    // no option answers on its own: each row is a radio, the one sender is Submit
    expect(html.split('type="radio"').length - 1).toBe(2);
    expect(html).not.toContain('type="checkbox"');
    expect(html.split("prompt-card-submit").length - 1).toBe(1);
    expect(html).toContain('<button type="button" class="btn prompt-card-submit" disabled="">Submit</button>');
    expect(html).toContain('role="radiogroup"');
    expect(html).not.toContain("prompt-card-confirm");
    // nothing picked yet: the box gives way to the line that says what to do
    expect(html).toContain("Pick an option to see its preview.");
    expect(html).not.toContain("prompt-card-preview");
  });

  it("checks the radio a number typed in the composer picked, and previews it", () => {
    const options = [{ label: "Sidebar", description: null, preview: "+---+---+\n| a | b |\n+---+---+" }, { label: "Tabs", description: null, preview: null }];
    const html = render(card({ options }), { option_index: 0 });
    expect(html).toContain('aria-label="Preview: Sidebar"');
    expect(html).toContain("| a | b |");
    expect(html).toContain("is-checked");
    // the pick is shown on its radio and sent by Submit, not by a Confirm step
    expect(html.split('checked=""').length - 1).toBe(1);
    expect(html).toContain("btn btn-primary prompt-card-submit");
    expect(html).not.toContain("prompt-card-confirm");
  });

  it("says so in the box when the checked option has no preview", () => {
    const options = [{ label: "Sidebar", description: null, preview: "+---+---+" }, { label: "Tabs", description: null }];
    const html = render(card({ options }), { option_index: 1 });
    expect(html).toContain('aria-label="Preview: Tabs"');
    expect(html).toContain("No preview for this option.");
  });

  it("answers a question without previews as it did before", () => {
    const html = render(card());
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain("prompt-card-preview");
    expect(html).not.toContain("prompt-card-submit");
    // the custom row is still the only way to say something else
    expect(html).toContain("Or type your own answer");
  });

  it("submits a multiple choice with previews by the same Submit button", () => {
    const options = [{ label: "Sidebar", description: null, preview: "+---+" }, { label: "Tabs", description: null }];
    const html = render(card({ multi_select: true, options }));
    expect(html.split('type="checkbox"').length - 1).toBe(2);
    expect(html).toContain('role="group"');
    expect(html).toContain(">Submit</button>");
    expect(html).toContain("Pick an option to see its preview.");
  });
});

if (languages) Object.defineProperty(navigator, "languages", languages);
