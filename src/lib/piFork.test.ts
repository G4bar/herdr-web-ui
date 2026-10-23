import { describe, expect, it } from "bun:test";

import { forkNoteName, piForks } from "./piFork.ts";

describe("a fork's quiet row names its message", () => {
  it("by the first line with something in it", () => {
    expect(forkNoteName("\n  Add a retry  \nto fetchData")).toBe("Add a retry");
    expect(forkNoteName("")).toBe("");
  });

  it("cut to one phrase, so a pasted file's first line cannot fill the row", () => {
    const name = forkNoteName("x".repeat(200));
    expect(name).toHaveLength(80);
    expect(name.endsWith("…")).toBe(true);
  });
});

describe("the notes a fork leaves", () => {
  it("keeps one per pane, says nothing when the same note lands again, and clears", () => {
    const note = { from: "Add a retry", sessionFile: "/tmp/before.jsonl" };
    let heard = 0;
    const off = piForks.subscribe(() => { heard += 1; });

    piForks.set("local:p1", note);
    expect(piForks.get("local:p1")).toEqual(note);
    expect(piForks.get("local:p2")).toBeNull();
    expect(heard).toBe(1);

    piForks.set("local:p1", { ...note });
    expect(heard).toBe(1);

    piForks.clear("local:p1");
    expect(piForks.get("local:p1")).toBeNull();
    expect(heard).toBe(2);

    piForks.clear("local:p1");
    expect(heard).toBe(2);
    off();
  });
});
