import { describe, expect, it } from "bun:test";
import { nextPiTreeFilter, piTreeFilterKey, piTreeRows, type PiTreeAnswer, type PiTreeNode } from "./piTree.ts";

/**
 * A session with one branch: the chat sent three messages, the user navigated back to the second and
 * asked something else, so the entries after it (a2, u3) were abandoned beside that path.
 */
function answer(): PiTreeAnswer {
  return {
    leafId: "u3",
    tree: [{
      entry: { id: "u1", parentId: null, type: "message", timestamp: "2026-10-01T10:02:00.000Z", message: { role: "user", content: [{ type: "text", text: "Add a retry to fetchData" }] } },
      children: [{
        entry: { id: "a1", parentId: "u1", type: "message", timestamp: "2026-10-01T10:02:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "I'll add exponential backoff" }, { type: "toolCall", id: "c1", name: "edit" }] } },
        children: [
          {
            entry: { id: "tree1", parentId: "a1", type: "model_change", timestamp: "2026-10-01T10:03:00.000Z", modelId: "sonnet" },
            children: [],
          },
          {
            entry: { id: "u2", parentId: "a1", type: "message", timestamp: "2026-10-01T10:05:00.000Z", message: { role: "user", content: [{ type: "text", text: "Actually use jitter" }] } },
            label: "jitter",
            labelTimestamp: "2026-10-01T10:06:00.000Z",
            children: [{
              entry: { id: "a2", parentId: "u2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Switched to full jitter" }] } },
              children: [{
                entry: { id: "u3", parentId: "a2", type: "message", message: { role: "user", content: "make it configurable" } },
                children: [],
              }],
            }],
          },
          {
            entry: { id: "u4", parentId: "a1", type: "message", message: { role: "user", content: [{ type: "text", text: "Try a circuit breaker instead" }] } },
            children: [{
              entry: { id: "a4", parentId: "u4", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Set up a breaker?" }] } },
              children: [],
            }],
          },
        ],
      }],
    }],
  };
}

const ids = (options?: Parameters<typeof piTreeRows>[1]): string[] => piTreeRows(answer(), options).map((row) => row.id);

describe("piTreeRows", () => {
  it("walks the tree in pi's order, with the branch holding the leaf first", () => {
    expect(ids()).toEqual(["u1", "a1", "u2", "a2", "u3", "u4", "a4"]);
  });

  it("names each row's role, its own words and how deep it sits", () => {
    const rows = piTreeRows(answer());
    expect(rows[0]).toMatchObject({ role: "user", text: "Add a retry to fetchData", depth: 0, forking: true, ts: "2026-10-01T10:02:00.000Z" });
    // u1's answer is a plain continuation: pi indents where the row forks, not once per entry
    expect(rows[1]).toMatchObject({ role: "assistant", depth: 0 });
    expect(rows[2]).toMatchObject({ id: "u2", label: "jitter", labelTimestamp: "2026-10-01T10:06:00.000Z", depth: 1 });
    // a message whose content is a plain string reads the same way
    expect(rows[4]).toMatchObject({ id: "u3", text: "make it configurable" });
    expect(rows[1]?.forking).toBe(false);
  });

  it("marks pi's leaf and the path to it, and leaves the abandoned branch out of that path", () => {
    const byId = new Map(piTreeRows(answer()).map((row) => [row.id, row]));
    expect(byId.get("u3")).toMatchObject({ current: true, active: true });
    expect(byId.get("u2")?.active).toBe(true);
    expect(byId.get("u4")?.active).toBe(false);
    expect(byId.get("u4")?.current).toBe(false);
  });

  it("hides bookkeeping in the default view, and shows it in all", () => {
    expect(ids()).not.toContain("tree1");
    expect(ids({ filter: "all" })).toContain("tree1");
  });

  it("keeps each view pi offers", () => {
    // no tools: the same as default for these entries, but a tool result row would go
    expect(ids({ filter: "no-tools" })).toEqual(["u1", "a1", "u2", "a2", "u3", "u4", "a4"]);
    expect(ids({ filter: "user-only" })).toEqual(["u1", "u2", "u3", "u4"]);
    expect(ids({ filter: "labeled-only" })).toEqual(["u2"]);
  });

  it("hides an assistant entry that only carried tool calls, unless it is the leaf", () => {
    const onlyCall: PiTreeAnswer = {
      leafId: "u1",
      tree: [{ entry: { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "read" }] } }, children: [] }],
    };
    expect(piTreeRows(onlyCall)).toEqual([]);
    const aborted: PiTreeAnswer = {
      leafId: "u1",
      tree: [{ entry: { id: "a1", type: "message", message: { role: "assistant", content: [], stopReason: "aborted" } }, children: [] }],
    };
    expect(piTreeRows(aborted).map((row) => row.id)).toEqual(["a1"]);
  });

  it("hangs a row whose parent the view filtered out under the nearest visible one", () => {
    // the tool-result row under a2 goes in the no-tools view; what answered it stays where it reads
    const withTool: PiTreeAnswer = {
      leafId: "u1",
      tree: [{
        entry: { id: "u1", parentId: null, type: "message", message: { role: "user", content: "run it" } },
        children: [{
          entry: { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "running" }] } },
          children: [{ entry: { id: "t1", parentId: "a1", type: "message", message: { role: "toolResult", toolName: "bash" } }, children: [] }],
        }],
      }],
    };
    expect(piTreeRows(withTool, { filter: "no-tools" }).map((row) => row.id)).toEqual(["u1", "a1"]);
    const toolRow = piTreeRows(withTool, { filter: "all" }).find((row) => row.id === "t1");
    // no row forks here, so the whole exchange stays on one column
    expect(toolRow).toMatchObject({ role: "tool", text: "bash", depth: 0 });
  });

  it("keeps only the rows every word of the query appears in", () => {
    // the label is searchable, and so is every row's own word: the answer that mentions it counts too
    expect(ids({ query: "jitter" })).toEqual(["u2", "a2"]);
    expect(ids({ query: "ACTUALLY jitter" })).toEqual(["u2"]);
    expect(ids({ query: "nothing here" })).toEqual([]);
  });

  it("folds a branch segment, counts what it hides, and leaves a plain chain unfolded", () => {
    const rows = piTreeRows(answer(), { folded: new Set(["u2"]) });
    expect(rows.map((row) => row.id)).toEqual(["u1", "a1", "u2", "u4", "a4"]);
    expect(rows.find((row) => row.id === "u2")).toMatchObject({ foldable: true, folded: true, hidden: 2 });
    // a1 holds a single branch: pi folds only where a segment starts
    expect(rows.find((row) => row.id === "a1")?.foldable).toBe(false);
    expect(rows.find((row) => row.id === "u4")).toMatchObject({ foldable: true, folded: false, hidden: 0 });
  });

  it("draws a guide under an ancestor that still has a row below it", () => {
    const rows = piTreeRows(answer());
    // one column per fork above: a line runs there while that branch still has a row below it
    expect(rows.find((row) => row.id === "u2")?.guides).toEqual([true]);
    expect(rows.find((row) => row.id === "u4")?.guides).toEqual([false]);
    // u2's own answer is a continuation of that column, and u4 is the branch's last one
    expect(rows.find((row) => row.id === "a2")?.guides).toEqual([true]);
    expect(rows.find((row) => row.id === "a4")?.guides).toEqual([false]);
    expect(rows[0]?.guides).toEqual([]);
  });

  /** One entry under the next: a plain conversation with no fork anywhere in it. */
  function chain(length: number, prefix = "e", rootParent: string | null = null): PiTreeNode {
    let node: PiTreeNode = {
      entry: { id: `${prefix}0`, parentId: rootParent, type: "message", message: { role: "user", content: "message 0" } },
    };
    for (let at = 1; at < length; at += 1) {
      node = { entry: { id: `${prefix}${at}`, parentId: `${prefix}${at - 1}`, type: "message", message: { role: at % 2 === 0 ? "user" : "assistant", content: `message ${at}` } }, children: [node] };
    }
    return node;
  }

  it("keeps a long single chain on one column, and walks it without exhausting the call stack", () => {
    const rows = piTreeRows({ leafId: "e4999", tree: [chain(5000)] });
    expect(rows).toHaveLength(5000);
    expect(Math.max(...rows.map((row) => row.depth))).toBe(0);
    expect(rows.every((row) => row.guides.length === 0)).toBe(true);
    // the leaf is last, and only it is where the conversation is
    expect(rows.at(-1)).toMatchObject({ id: "e4999", current: true, active: true, depth: 0 });
  });

  it("indents once where a long chain forks, and not again along either branch", () => {
    const rows = piTreeRows({
      leafId: "a0",
      tree: [{
        entry: { id: "root", parentId: null, type: "message", message: { role: "user", content: "start" } },
        children: [chain(50, "a", "root"), chain(50, "b", "root")],
      }],
    });
    expect(Math.max(...rows.map((row) => row.depth))).toBe(1);
    expect(rows.filter((row) => row.depth === 1)).toHaveLength(100);
    expect(rows[0]).toMatchObject({ id: "root", foldable: true, depth: 0 });
    // both branches hang one column in, and the one holding the leaf comes first
    expect(rows[1]).toMatchObject({ id: "a0", depth: 1, guides: [true], active: true });
    expect(rows[51]).toMatchObject({ id: "b0", depth: 1, guides: [false], active: false });
  });

  it("is empty for no tree at all", () => {
    expect(piTreeRows(null)).toEqual([]);
    expect(piTreeRows({ tree: [] })).toEqual([]);
  });
});

describe("pi's tree filter keys", () => {
  it("cycles both ways, wrapping at the ends", () => {
    expect(nextPiTreeFilter("all")).toBe("default");
    expect(nextPiTreeFilter("default", -1)).toBe("all");
    expect(nextPiTreeFilter("no-tools")).toBe("user-only");
  });

  it("maps Ctrl+letter to the view pi binds it to, toggling back to default", () => {
    expect(piTreeFilterKey("all", "d")).toBe("default");
    expect(piTreeFilterKey("default", "t")).toBe("no-tools");
    expect(piTreeFilterKey("no-tools", "t")).toBe("default");
    expect(piTreeFilterKey("default", "U")).toBe("user-only");
    expect(piTreeFilterKey("user-only", "u")).toBe("default");
    expect(piTreeFilterKey("default", "l")).toBe("labeled-only");
    expect(piTreeFilterKey("all", "a")).toBe("default");
    expect(piTreeFilterKey("default", "a")).toBe("all");
    expect(piTreeFilterKey("default", "o")).toBe("no-tools");
    expect(piTreeFilterKey("default", "o", true)).toBe("all");
    expect(piTreeFilterKey("default", "x")).toBeNull();
  });
});
