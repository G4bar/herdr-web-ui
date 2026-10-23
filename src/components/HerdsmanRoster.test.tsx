import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

import type { HerdsmanAgent, PiNativeHerdsman } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";

const { HerdsmanRoster } = await import("./HerdsmanRoster.tsx");
const { HerdsmanChip } = await import("./HerdsmanChip.tsx");

const browserGlobals = ["window", "document", "localStorage", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
// the roster's words go through useT, which reads the browser's languages
const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });

beforeAll(() => {
  for (const name of browserGlobals) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const store = new Map<string, string>();
  const media = { matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false };
  const localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => media, addEventListener() {}, removeEventListener() {}, localStorage } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    querySelector: () => null,
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, lang: "", colorScheme: "" },
  } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterAll(() => {
  if (savedLanguages) Object.defineProperty(navigator, "languages", savedLanguages);
  else Reflect.deleteProperty(navigator, "languages");
  for (const name of browserGlobals) {
    const saved = savedGlobals.get(name);
    if (saved) Object.defineProperty(globalThis, name, saved);
    else Reflect.deleteProperty(globalThis, name);
  }
});

/**
 * One lead that delegated: a designer waiting on an answer, a scout with a chain of agents under it
 * four levels deep, two finished agents (the newer first) and a closed one, plus an agent whose
 * parent is not in the list and so stands at the top level.
 */
const agents: HerdsmanAgent[] = [
  { label: "lead", definition: "lead", parent: null, state: "running", startedAt: 0 },
  { label: "visual_designer", definition: "designer", parent: "lead", state: "asks", startedAt: 500, question: { text: "Which colour?", files: [] } },
  { label: "scout_ui", definition: "scout", parent: "lead", state: "running", startedAt: 1_000, activity: ["Read src/components/ChatView.tsx"] },
  { label: "implementer", definition: "implementer", parent: "scout_ui", state: "running", startedAt: 2_000 },
  { label: "deep_1", definition: "implementer", parent: "implementer", state: "running", startedAt: 3_000 },
  { label: "deep_2", definition: "implementer", parent: "deep_1", state: "running", startedAt: 4_000 },
  { label: "deep_3", definition: "implementer", parent: "deep_2", state: "running", startedAt: 5_000 },
  { label: "researcher", definition: "researcher", parent: "lead", state: "finished", startedAt: 0, endedAt: 5_000 },
  { label: "researcher_old", definition: "researcher", parent: "lead", state: "finished", startedAt: 0, endedAt: 3_000 },
  { label: "old_agent", definition: "scout", parent: "lead", state: "closed", startedAt: 0, endedAt: 4_000 },
  { label: "orphan", definition: "scout", parent: "ghost", state: "closed", startedAt: 0, endedAt: 2_000 },
];

const mount = async (list: HerdsmanAgent[]) => {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(SettingsProvider, {
      children: createElement(HerdsmanRoster, { herdsman: { agents: list, capabilities: [] }, now: 7_000 }),
    }));
  });
  return renderer!;
};

/** every string drawn inside `node`, in order */
const strings = (node: TestRenderer.ReactTestInstance): string[] =>
  node.children.flatMap((child) => (typeof child === "string" || typeof child === "number" ? [String(child)] : strings(child)));
const headers = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findAll((node) => node.type === "button" && node.props.className === "hm-section");
const rows = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findAll((node) => node.type === "li" && node.props.role === "treeitem");
const rowButtons = (renderer: TestRenderer.ReactTestRenderer) => rows(renderer).map((row) => row.findByProps({ className: "hm-row" }));
const labels = (renderer: TestRenderer.ReactTestRenderer): string[] =>
  rows(renderer).map((row) => String(row.findAllByProps({ className: "hm-row-label" })[0]!.children[0]));
const sectionOf = (button: TestRenderer.ReactTestInstance): string => String(button.props["data-hm-section"]);

describe("HerdsmanRoster", () => {
  it("draws the sections in the popover's order, each counting its whole subtree", async () => {
    const renderer = await mount(agents);
    expect(headers(renderer).map((header) => strings(header).join(" "))).toEqual(["Running 8", "Closed 1"]);
  });

  it("keeps a root and its delegates together, in the root's section", async () => {
    const renderer = await mount(agents);
    const inSection = (section: string) => rowButtons(renderer).filter((button) => sectionOf(button) === section).map((button) => String(button.findAllByProps({ className: "hm-row-label" })[0]!.children[0]));
    expect(inSection("running")).toEqual(["lead", "visual_designer", "scout_ui", "implementer", "deep_1", "researcher", "researcher_old", "old_agent"]);
    expect(inSection("closed")).toEqual(["orphan"]);
  });

  it("draws a running child right under its asking root, inside the root's section", async () => {
    const renderer = await mount([
      { label: "lead", definition: "lead", parent: null, state: "asks", startedAt: 0, question: { text: "Which colour?", files: [] } },
      { label: "implementer", definition: "implementer", parent: "lead", state: "running", startedAt: 1_000 },
    ]);
    expect(labels(renderer)).toEqual(["lead", "implementer"]);
    expect(headers(renderer).map((header) => strings(header).join(" "))).toEqual(["Asks you 2"]);
    expect(sectionOf(rowButtons(renderer)[1]!)).toBe("asks");
    expect(rows(renderer)[1]!.props["aria-level"]).toBe(2);
  });

  it("indents a child under its parent and keeps its state word for a screen reader", async () => {
    const renderer = await mount(agents);
    const lead = rows(renderer).find((row) => labels(renderer)[rows(renderer).indexOf(row)] === "lead")!;
    const child = rows(renderer).find((row) => row.findAllByProps({ className: "hm-row-label" })[0]!.children[0] === "visual_designer")!;
    expect(lead.props["aria-level"]).toBe(1);
    expect(child.props["aria-level"]).toBe(2);
    expect(strings(child)).toContain("Asks you");
    const icon = child.findAll((node) => String(node.props.className ?? "").includes("hm-row-icon"))[0]!;
    expect(icon.props.className).toBe("hm-row-icon is-asks");
  });

  it("draws an agent whose parent is unknown at the top level", async () => {
    const renderer = await mount(agents);
    const orphan = rows(renderer).find((row) => row.findAllByProps({ className: "hm-row-label" })[0]!.children[0] === "orphan")!;
    expect(orphan.props["aria-level"]).toBe(1);
  });

  it("summarises the agents deeper than the last drawn level", async () => {
    const renderer = await mount(agents);
    const deeper = rows(renderer).find((row) => row.findAllByProps({ className: "hm-row-label" })[0]!.children[0] === "deep_1")!;
    expect(strings(deeper)).toContain("+2 deeper");
    expect(labels(renderer)).not.toContain("deep_2");
  });

  it("hides a section's rows when its header is pressed, keeping the header and its count", async () => {
    const renderer = await mount(agents);
    const running = headers(renderer).find((header) => strings(header).join(" ").startsWith("Running"))!;
    await act(async () => { running.props.onClick(); });
    expect(labels(renderer)).toEqual(["orphan"]);
    expect(headers(renderer).map((header) => strings(header).join(" "))).toContain("Running 8");
    expect(running.props["aria-expanded"]).toBe(false);
  });

  it("says how agents start when there are none", async () => {
    const renderer = await mount([]);
    expect(strings(renderer.root).join(" ")).toContain("No agents yet. Pi starts them when it delegates work.");
    expect(renderer.root.findAllByProps({ role: "tree" })).toEqual([]);
  });
});

/** One chip over a snapshot, with the presses and announcements it hands to its caller. */
const mountChip = async (herdsman: PiNativeHerdsman | null, handlers: { onOpenAgent?: (label: string) => void; onAnnounce?: (text: string) => void } = {}) => {
  const element = (next: PiNativeHerdsman | null) => createElement(SettingsProvider, {
    children: createElement(HerdsmanChip, { herdsman: next, onOpenAgent: handlers.onOpenAgent, onAnnounce: handlers.onAnnounce }),
  });
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => { renderer = TestRenderer.create(element(herdsman)); });
  return {
    renderer: renderer!,
    update: async (next: PiNativeHerdsman | null): Promise<void> => { await act(async () => { renderer!.update(element(next)); }); },
  };
};

const chipToggle = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findAll((node) => node.type === "button" && String(node.props.className ?? "").startsWith("bg-tasks-toggle"))[0]!;
const chipRows = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findAll((node) => node.type === "button" && node.props.className === "hm-row");

const one = (label: string, state: HerdsmanAgent["state"]): PiNativeHerdsman => ({
  agents: [{ label, definition: "scout", parent: null, state, startedAt: 0, ...(state === "running" || state === "asks" ? {} : { endedAt: 5_000 }) }],
  capabilities: [],
});

describe("HerdsmanChip", () => {
  it("draws no chip for a session without a snapshot or agents", async () => {
    for (const herdsman of [null, { agents: [], capabilities: [] }]) {
      const { renderer } = await mountChip(herdsman);
      expect(renderer.toJSON()).toBeNull();
    }
  });

  it("names the count and the number waiting for you, over the chip's counts line", async () => {
    const { renderer } = await mountChip({ agents, capabilities: [] });
    expect(chipToggle(renderer).props["aria-label"]).toBe("Agents: 11, 1 waiting for you");
    expect(chipToggle(renderer).props.title).toBe("6 running · 1 asks you");
  });

  it("counts what ended once nothing runs and nobody asks", async () => {
    const { renderer } = await mountChip(one("researcher", "finished"));
    expect(chipToggle(renderer).props.title).toBe("1 finished");
    expect(String(chipToggle(renderer).props.className)).toContain("is-idle");
  });

  it("draws the roster when the chip is pressed", async () => {
    const { renderer } = await mountChip({ agents, capabilities: [] });
    expect(chipToggle(renderer).props["aria-expanded"]).toBe(false);
    await act(async () => { chipToggle(renderer).props.onClick(); });
    expect(chipToggle(renderer).props["aria-expanded"]).toBe(true);
    expect(renderer.root.findAll((node) => String(node.props.className ?? "").includes("hm-menu")).length).toBe(1);
    expect(labels(renderer)).toContain("scout_ui");
    await act(async () => { renderer.unmount(); });
  });

  it("draws the blocked dot only while an agent asks", async () => {
    const asking = await mountChip({ agents, capabilities: [] });
    expect(asking.renderer.root.findAllByProps({ className: "hm-chip-dot" }).length).toBe(1);
    const running = await mountChip({ agents: agents.filter((agent) => agent.state !== "asks"), capabilities: [] });
    expect(running.renderer.root.findAllByProps({ className: "hm-chip-dot" }).length).toBe(0);
  });

  it("hands a pressed row's label, and the first row's for the panel, to the caller", async () => {
    const pressed: string[] = [];
    const { renderer } = await mountChip({ agents, capabilities: [] }, { onOpenAgent: (label) => pressed.push(label) });
    await act(async () => { chipToggle(renderer).props.onClick(); });
    const scout = chipRows(renderer).find((row) => String(row.findAllByProps({ className: "hm-row-label" })[0]!.children[0]) === "scout_ui")!;
    await act(async () => { scout.props.onClick(); });
    await act(async () => { renderer.root.findAllByProps({ className: "hm-open-panel" })[0]!.props.onClick(); });
    expect(pressed).toEqual(["scout_ui", "lead"]);
    await act(async () => { renderer.unmount(); });
  });

  it("announces a state change once, and nothing for the first snapshot", async () => {
    const said: string[] = [];
    const { renderer, update } = await mountChip(one("scout_ui", "running"), { onAnnounce: (text) => said.push(text) });
    expect(said).toEqual([]);
    await update(one("scout_ui", "finished"));
    expect(said).toEqual(["scout_ui finished"]);
    await act(async () => { renderer.unmount(); });
  });

  it("says nothing when an agent closes", async () => {
    const said: string[] = [];
    const { update } = await mountChip(one("scout_ui", "running"), { onAnnounce: (text) => said.push(text) });
    await update(one("scout_ui", "closed"));
    expect(said).toEqual([]);
  });
});
