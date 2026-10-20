import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { OPENCODE_SKILL_ACCEPT_KEY, OPENCODE_SKILL_ROW_WAIT_MS, skillRowSelected, skillTokens, typeWithSkills, type SkillAttachIo } from "./opencode-skill-attach.ts";

const fixture = (width: "narrow" | "wide") => readFileSync(join(import.meta.dir, "fixtures", `opencode-autocomplete-2.0.32-skill-${width}.txt`), "utf8");

/** A scripted pane: what each write did, and the screen it shows next; time moves only when waited on. */
function pane(screens: (writes: string[]) => string): SkillAttachIo & { writes: string[] } {
  const writes: string[] = [];
  let clock = 0;
  return {
    writes,
    sendText: async (text) => { writes.push(`text:${text}`); },
    sendKeys: async (keys) => { writes.push(`keys:${keys.join(",")}`); },
    screen: async () => screens(writes),
    wait: async (ms) => { clock += ms; },
    now: () => clock,
  };
}

describe("skillRowSelected", () => {
  it.each(["narrow", "wide"] as const)("recognizes the selected @effect row in the recorded %s autocomplete", (width) => {
    expect(skillRowSelected(fixture(width), "effect")).toBe(true);
  });

  it.each(["narrow", "wide"] as const)("refuses another id, a prefix, and a box whose first row is another option (%s)", (width) => {
    const screen = fixture(width);
    expect(skillRowSelected(screen, "eff")).toBe(false);
    expect(skillRowSelected(screen, "later")).toBe(false);
    const lines = screen.split("\n");
    const first = lines.findIndex((line) => line.includes("┃ @effect "));
    const second = lines[first + 1]!;
    const swapped = [...lines.slice(0, first), second, lines[first]!, ...lines.slice(first + 2)].join("\n");
    expect(skillRowSelected(swapped, "effect")).toBe(false);
  });

  const mutate = (width: "narrow" | "wide", edit: (lines: string[], row: number) => void): string => {
    const lines = fixture(width).split("\n");
    const row = lines.findIndex((line) => line.includes("┃ @effect "));
    edit(lines, row);
    return lines.join("\n");
  };

  it.each(["narrow", "wide"] as const)("refuses a row of another kind with the same @id (%s)", (width) => {
    // the recorded row ends in the kind label "skill"; a file or agent row names no such kind
    expect(skillRowSelected(mutate(width, (lines, row) => { lines[row] = lines[row]!.replace(/skill ┃/u, " file ┃"); }), "effect")).toBe(false);
    expect(skillRowSelected(mutate(width, (lines, row) => { lines[row] = lines[row]!.replace(/@effect .* ┃$/u, (match) => `${"@effect file".padEnd(match.length - 2)} ┃`); }), "effect")).toBe(false);
  });

  it.each(["narrow", "wide"] as const)("refuses a box whose rows do not share its right border (%s)", (width) => {
    expect(skillRowSelected(mutate(width, (lines, row) => { lines[row + 1] = `${lines[row + 1]!.trimEnd().slice(0, -1).trimEnd()} ┃`; }), "effect")).toBe(false);
  });

  it.each(["narrow", "wide"] as const)("refuses the box without the recorded input area under it (%s)", (width) => {
    // no blank border line between the box and the input row
    expect(skillRowSelected(mutate(width, (lines, row) => { lines.splice(row + 3, 1); }), "effect")).toBe(false);
    // no prompt bottom edge under the input area
    expect(skillRowSelected(mutate(width, (lines) => { for (const [index, line] of lines.entries()) if (line.includes("╹")) lines[index] = ""; }), "effect")).toBe(false);
  });

  it.each(["narrow", "wide"] as const)("refuses a prompt bottom that is not the recorded full-width border (%s)", (width) => {
    expect(skillRowSelected(mutate(width, (lines) => {
      const at = lines.findIndex((line) => line.includes("╹▀"));
      lines[at] = `${lines[at]!.slice(0, lines[at]!.indexOf("╹"))}╹▀`;
    }), "effect")).toBe(false);
  });

  it("refuses a two-line layout that only looks like a box and an input row", () => {
    expect(skillRowSelected("┃ @effect Apply  skill ┃\n┃ @effect", "effect")).toBe(false);
    expect(skillRowSelected("┃ @effect file ┃\n┃\n┃ @effect\n┃\n┃ x\n╹▀▀▀▀", "effect")).toBe(false);
  });

  it("refuses the screen once the box has closed", () => {
    const closed = fixture("wide").split("\n").filter((line) => !/┃.*┃$/u.test(line.trimEnd())).join("\n");
    expect(skillRowSelected(closed, "effect")).toBe(false);
  });
});

describe("skillTokens", () => {
  it("keeps only known skill ids, in order and once", () => {
    expect(skillTokens("@effect apply it @other and @effect again, mail@effect", ["effect", "review"])).toEqual(["effect"]);
    expect(skillTokens("@review then @effect", ["effect", "review"])).toEqual(["review", "effect"]);
  });
});

describe("typeWithSkills", () => {
  it("types the token, accepts its recognized row with the recorded key, then types the rest once", async () => {
    const io = pane((writes) => writes.at(-1) === "text:@effect" ? fixture("narrow") : "");
    expect(await typeWithSkills("@effect apply it", ["effect"], () => true, io, async () => {})).toEqual({ attached: ["effect"], missed: [], prompt: [{ typed: "@effect " }, { pasted: "apply it" }] });
    // the accepted row inserts its own space
    expect(io.writes).toEqual(["text:@effect", `keys:${OPENCODE_SKILL_ACCEPT_KEY}`, "text:\u001b[200~apply it\u001b[201~"]);
  });

  it("leaves an unrecognized token as plain text after the wait, closing the box with the text's own space", async () => {
    const io = pane(() => "");
    expect(await typeWithSkills("please @effect apply it", ["effect"], () => true, io, async () => {})).toEqual({ attached: [], missed: ["effect"], prompt: [{ pasted: "please " }, { typed: "@effect" }, { pasted: " apply it" }] });
    expect(io.writes).toEqual(["text:\u001b[200~please \u001b[201~", "text:@effect", "text:\u001b[200~ apply it\u001b[201~"]);
    expect(io.now()).toBeGreaterThanOrEqual(OPENCODE_SKILL_ROW_WAIT_MS);
  });

  it("adds a space after a trailing unrecognized token, so Enter cannot take the box", async () => {
    const io = pane(() => "");
    await typeWithSkills("run @effect", ["effect"], () => true, io, async () => {});
    expect(io.writes.at(-1)).toBe("text: ");
  });

  it("re-checks before every write, and stops typing at the first refused check", async () => {
    const io = pane((writes) => writes.at(-1) === "text:@effect" ? fixture("narrow") : "");
    let checks = 0;
    const revalidate = async () => { if (++checks === 2) throw Object.assign(new Error("changed"), { code: "pending_target_changed" }); };
    await expect(typeWithSkills("@effect apply it", ["effect"], () => true, io, revalidate)).rejects.toMatchObject({ code: "pending_target_changed" });
    expect(io.writes).toEqual(["text:@effect"]);
  });

  it("types nothing when the first check refuses", async () => {
    const io = pane(() => fixture("wide"));
    await expect(typeWithSkills("please @effect", ["effect"], () => true, io, async () => { throw new Error("session changed"); })).rejects.toThrow("session changed");
    expect(io.writes).toEqual([]);
  });

  it("writes nothing once the sender may no longer type", async () => {
    const io = pane(() => fixture("wide"));
    await expect(typeWithSkills("@effect apply it", ["effect"], () => false, io, async () => {})).rejects.toMatchObject({ code: "cancelled" });
    expect(io.writes).toEqual([]);
  });
});
