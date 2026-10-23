import { describe, expect, it } from "bun:test";
import type { HerdsmanAgent, HerdsmanAgentState, PiNativeHerdsman } from "../../shared/protocol.ts";
import { herdsmanChanges, herdsmanCounts, herdsmanElapsedMs, herdsmanLive, herdsmanRows } from "./herdsman.ts";

function agent(label: string, state: HerdsmanAgentState, extra: Partial<HerdsmanAgent> = {}): HerdsmanAgent {
  return { label, definition: "worker", parent: null, state, ...extra };
}

function snapshot(...agents: HerdsmanAgent[]): PiNativeHerdsman {
  return { agents, capabilities: [] };
}

function labels(herdsman: PiNativeHerdsman, folds?: Parameters<typeof herdsmanRows>[1]): string[] {
  return herdsmanRows(herdsman, folds).map((row) => row.agent.label);
}

describe("herdsman roster", () => {
  it("counts agents, the running ones and the ones asking the owner", () => {
    expect(herdsmanCounts(null)).toEqual({ total: 0, running: 0, asking: 0 });
    const tree = snapshot(agent("a", "starting"), agent("b", "running"), agent("c", "asks"), agent("d", "running"), agent("e", "finished"));
    expect(herdsmanCounts(tree)).toEqual({ total: 5, running: 3, asking: 1 });
  });

  it("draws asks, then running, then finished newest first, then closed", () => {
    const tree = snapshot(
      agent("closed-old", "closed", { startedAt: 1, endedAt: 90 }),
      agent("done-old", "finished", { startedAt: 1, endedAt: 10 }),
      agent("done-new", "failed", { startedAt: 2, endedAt: 20 }),
      agent("run-later", "running", { startedAt: 50 }),
      agent("run-first", "running", { startedAt: 30 }),
      agent("ask-second", "asks", { startedAt: 20 }),
      agent("ask-first", "asks", { startedAt: 10 }),
      agent("closed-new", "closed", { startedAt: 1, endedAt: 95 }),
    );
    expect(labels(tree)).toEqual(["ask-first", "ask-second", "run-first", "run-later", "done-new", "done-old", "closed-new", "closed-old"]);
    expect(herdsmanRows(tree).map((row) => row.section)).toEqual(["asks", "asks", "running", "running", "finished", "finished", "closed", "closed"]);
  });

  it("puts running agents without a start and finished ones without an end after their known peers", () => {
    const tree = snapshot(agent("ask-no-start", "asks"), agent("ask-started", "asks", { startedAt: 5 }), agent("done-no-end", "finished"), agent("done-ended", "finished", { endedAt: 5 }));
    expect(labels(tree)).toEqual(["ask-started", "ask-no-start", "done-ended", "done-no-end"]);
  });

  it("nests a child under its parent and draws an unknown parent at the top level", () => {
    const tree = snapshot(agent("lead", "running", { startedAt: 1 }), agent("child", "running", { startedAt: 2, parent: "lead" }), agent("orphan", "running", { startedAt: 3, parent: "gone" }));
    const rows = herdsmanRows(tree);
    expect(rows.map((row) => [row.agent.label, row.depth])).toEqual([["lead", 0], ["child", 1], ["orphan", 0]]);
    expect(rows[0]!.hasChildren).toBe(true);
    expect(rows[1]!.hasChildren).toBe(false);
  });

  it("treats a self-parent and a two-agent cycle as roots and still draws each agent once", () => {
    const tree = snapshot(agent("itself", "running", { startedAt: 1, parent: "itself" }), agent("a", "running", { startedAt: 2, parent: "b" }), agent("b", "running", { startedAt: 3, parent: "a" }));
    const drawn = labels(tree);
    expect(drawn.length).toBe(3);
    expect([...drawn].sort()).toEqual(["a", "b", "itself"]);
    expect(herdsmanRows(tree)[0]!.depth).toBe(0);
  });

  it("hides a folded section's roots and their subtrees", () => {
    const tree = snapshot(agent("lead", "running", { startedAt: 1 }), agent("done", "finished", { endedAt: 9 }), agent("done-child", "finished", { parent: "done", endedAt: 9 }));
    expect(labels(tree, { sections: ["finished"] })).toEqual(["lead"]);
    expect(labels(tree, { sections: ["running"] })).toEqual(["done", "done-child"]);
  });

  it("keeps a folded label's row and hides its children", () => {
    const tree = snapshot(agent("lead", "running", { startedAt: 1 }), agent("child", "running", { startedAt: 2, parent: "lead" }), agent("grandchild", "running", { startedAt: 3, parent: "child" }));
    const rows = herdsmanRows(tree, { labels: ["child"] });
    expect(rows.map((row) => row.agent.label)).toEqual(["lead", "child"]);
    expect(rows[1]!.folded).toBe(true);
    expect(rows[1]!.hasChildren).toBe(true);
  });

  it("summarises the descendants below depth 3 as deeper", () => {
    const tree = snapshot(
      agent("d0", "running", { startedAt: 1 }),
      agent("d1", "running", { startedAt: 2, parent: "d0" }),
      agent("d2", "running", { startedAt: 3, parent: "d1" }),
      agent("d3", "running", { startedAt: 4, parent: "d2" }),
      agent("d4", "running", { startedAt: 5, parent: "d3" }),
      agent("d5", "running", { startedAt: 6, parent: "d4" }),
    );
    const rows = herdsmanRows(tree);
    expect(rows.map((row) => [row.agent.label, row.depth, row.deeper])).toEqual([["d0", 0, 0], ["d1", 1, 0], ["d2", 2, 0], ["d3", 3, 2]]);
  });

  it("draws one row for two agents sharing a label, the first in snapshot order", () => {
    const tree = snapshot(agent("twin", "running", { startedAt: 1, definition: "first" }), agent("twin", "finished", { definition: "second" }));
    const rows = herdsmanRows(tree);
    expect(rows.length).toBe(1);
    expect(rows[0]!.agent.definition).toBe("first");
  });
});

describe("herdsman announcements", () => {
  const before = snapshot(agent("idle-one", "running"), agent("done", "running"), agent("failed-soon", "running"), agent("quiet", "running"), agent("shut", "running"));

  it("announces only the states the user needs, asks before failed before finished", () => {
    const after = snapshot(agent("idle-one", "finished"), agent("done", "finished"), agent("failed-soon", "failed"), agent("quiet", "asks"), agent("shut", "closed"), agent("newcomer", "finished"));
    expect(herdsmanChanges(before, after)).toEqual([
      { label: "quiet", state: "asks" },
      { label: "failed-soon", state: "failed" },
      { label: "idle-one", state: "finished" },
      { label: "done", state: "finished" },
    ]);
  });

  it("announces nothing for churn, a closed agent or an agent that was not there before", () => {
    expect(herdsmanChanges(before, snapshot(agent("idle-one", "running"), agent("done", "running"), agent("failed-soon", "running"), agent("quiet", "running"), agent("shut", "running")))).toEqual([]);
    expect(herdsmanChanges(before, snapshot(agent("idle-one", "running"), agent("done", "running"), agent("failed-soon", "running"), agent("quiet", "running"), agent("shut", "closed")))).toEqual([]);
    expect(herdsmanChanges(before, snapshot(agent("idle-one", "finished"))).map((change) => change.label)).toEqual(["idle-one"]);
    expect(herdsmanChanges(null, snapshot(agent("fresh", "finished")))).toEqual([]);
  });
});

describe("herdsman elapsed time", () => {
  it("runs up for a live agent, freezes for an ended one and is unknown without the stamps it needs", () => {
    expect(herdsmanElapsedMs(agent("live", "running", { startedAt: 1_000 }), 5_000)).toBe(4_000);
    expect(herdsmanElapsedMs(agent("ended", "finished", { startedAt: 1_000, endedAt: 2_500 }), 9_000)).toBe(1_500);
    expect(herdsmanElapsedMs(agent("no-start", "running"), 5_000)).toBeNull();
    expect(herdsmanElapsedMs(agent("ended-no-stamp", "finished", { startedAt: 1_000 }), 5_000)).toBeNull();
    expect(herdsmanElapsedMs(agent("clock-skew", "running", { startedAt: 5_000 }), 1_000)).toBe(0);
  });

  it("ticks only while something can still move", () => {
    expect(herdsmanLive(null)).toBe(false);
    expect(herdsmanLive(snapshot(agent("done", "finished"), agent("stale", "stale")))).toBe(false);
    expect(herdsmanLive(snapshot(agent("done", "finished"), agent("asks", "asks")))).toBe(true);
  });
});
