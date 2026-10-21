import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// The card's spacing is one column with the composer's box (DESIGN.md, the ask_user_question card):
// a 16px inset on its top and sides, its controls on the text column, and its bottom 16px held by
// a sticky strip. These are the rules that file order alone would not keep.

const sheet = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule with exactly this selector, whitespace collapsed. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open)).replace(/\s+/g, " ").trim();
}

describe("the question card's spacing", () => {
  const card = sheet("PromptCard.css");

  it("pads its top and sides by 16px and its bottom by a strip the same height", () => {
    expect(rule(card, ".prompt-card")).toContain("padding: var(--space-4) var(--space-4) 0;");
    expect(rule(card, ".prompt-card::after")).toContain("height: var(--space-4);");
    expect(rule(card, ".prompt-card")).toContain("scroll-padding-bottom: calc(var(--touch-target) + var(--space-4));");
  });

  it("bleeds the option rows out to the card's edge, so their controls start on the text column", () => {
    expect(rule(card, ".prompt-card-options")).toContain("margin-inline: calc(-1 * (var(--space-2) + var(--hairline)));");
    const row = rule(card, ".prompt-card-option");
    expect(row).toContain("padding: var(--space-1) var(--space-2);");
    expect(row).toContain("align-items: flex-start;");
    expect(row).toContain("--row-line: calc(var(--fs-sm) * var(--lh-base));");
    // the box and the number centre on the label's first line
    expect(rule(card, ".prompt-card-option input")).toContain("margin: calc((var(--row-line) - 16px) / 2) 0 0;");
    expect(rule(card, ".prompt-card-number")).toContain("margin-top: calc((var(--row-line) - 1.6em) / 2);");
  });

  it("keeps Submit on the card's fold, right-aligned, and the confirm row on the same 16px", () => {
    const actions = rule(card, ".prompt-card-actions");
    expect(actions).toContain("position: sticky;");
    expect(actions).toContain("bottom: var(--space-4);");
    expect(actions).toContain("justify-content: flex-end;");
    expect(rule(card, ".prompt-card-confirm")).toContain("bottom: var(--space-4);");
    // nothing is left of the old in-flow Submit
    expect(card).not.toContain(".prompt-card-submit {");
  });

  it("rings a focused row instead of the box inside it", () => {
    expect(card).toContain(".prompt-card-option:has(> input:focus-visible) {");
    expect(rule(card, ".prompt-card-option input:focus-visible")).toBe("outline: none;");
  });

  it("keeps 12px under the card, and 8px with the keyboard up", () => {
    const composer = sheet("Composer.css");
    expect(rule(composer, ".prompt-dock:not(:empty)")).toBe("margin-bottom: var(--space-3);");
    expect(rule(composer, "[data-keyboard] .prompt-dock:not(:empty)")).toBe("margin-bottom: var(--space-2);");
    // the view-only pane's larger inset still wins, being more specific
    expect(rule(composer, ".prompt-dock:not(:empty):last-child")).toBe("margin-bottom: var(--space-4);");
  });
});
