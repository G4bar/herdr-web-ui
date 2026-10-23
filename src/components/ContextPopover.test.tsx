import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

import type { PiNativeStats } from "../../shared/protocol.ts";
import { ApiError, type PiRpcCommand } from "../lib/api.ts";
import { SettingsProvider } from "../lib/settings.ts";

const { ContextPopover, HOVER_CLOSE_MS, HOVER_OPEN_MS, costText, ringLevel, usedPercent } = await import("./ContextPopover.tsx");

/** the listeners the component put on `window`, so a test can send the key the browser would */
const windowListeners = new Map<string, Set<EventListener>>();
const sendWindowEvent = (type: string, event: unknown): void => {
  for (const listener of windowListeners.get(type) ?? []) listener(event as Event);
};

const browserGlobals = ["window", "document", "HTMLElement", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "getComputedStyle"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });

beforeAll(() => {
  for (const name of browserGlobals) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const store = new Map<string, string>();
  const media = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false, query });
  const localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: (query: string) => media(query), getSelection: () => null, localStorage,
    addEventListener(type: string, listener: EventListener) { windowListeners.set(type, (windowListeners.get(type) ?? new Set()).add(listener)); },
    removeEventListener(type: string, listener: EventListener) { windowListeners.get(type)?.delete(listener); },
    innerWidth: 1280, innerHeight: 800, requestAnimationFrame: (run: () => void) => setTimeout(run, 0), cancelAnimationFrame: () => {},
    history: { state: null as unknown, pushState(state: unknown) { this.state = state; }, replaceState(state: unknown) { this.state = state; }, back() {} },
    location: { href: "http://localhost/" },
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    addEventListener() {}, removeEventListener() {}, activeElement: null, body: {}, querySelector: () => null,
    getElementById: () => null, getSelection: () => null,
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, lang: "", colorScheme: "" },
  } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class Element {} });
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

/** `get_session_stats` as the bridge reduces it: a 200k window, its tokens and cost set by the test. */
const statsOf = (used: number, cost: number): PiNativeStats => ({
  userMessages: 2,
  assistantMessages: 2,
  toolCalls: 3,
  totalMessages: 7,
  tokens: { input: 1_200_000, output: 98_000, cacheRead: 800_000, cacheWrite: 40_000, total: 2_138_000 },
  cost,
  contextUsage: { tokens: used, contextWindow: 200_000, percent: Math.round((used / 200_000) * 100) },
});

const mount = async (stats: PiNativeStats | null, piRpc: (command: PiRpcCommand) => Promise<unknown>, props: Record<string, unknown> = {}) => {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(SettingsProvider, {
      children: createElement(ContextPopover, { stats, piRpc, ...props }),
    }));
  });
  return renderer!;
};

const ring = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findByProps({ "aria-haspopup": "dialog" });
const dialog = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findAllByProps({ role: "dialog" });

/** Every text a reader sees, in order, for the assertions below. */
const words = (renderer: TestRenderer.ReactTestRenderer): string[] =>
  renderer.root.findAll((node) => typeof node.type === "string").flatMap((node) => (node.children ?? []).filter((child): child is string => typeof child === "string"));

/** One element's text whole, where its parts are separate children (`{used} / {window}`). */
const textOf = (renderer: TestRenderer.ReactTestRenderer, className: string): string =>
  renderer.root.findByProps({ className }).children.filter((child): child is string => typeof child === "string").join("");

const open = async (renderer: TestRenderer.ReactTestRenderer): Promise<void> => {
  await act(async () => { ring(renderer).props.onClick(); });
  await act(async () => {});
};

/** Waits for a condition instead of sleeping a set time, bounded so a broken one fails instead of hanging (AGENTS.md). */
const until = async (done: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 4_000;
  for (let i = 0; !done(); i++) {
    if (Date.now() > deadline) throw new Error(what);
    // the ring's own hover timer updates between these frames: what the popover opening means
    await Bun.sleep(25);
    await act(async () => {});
  }
};

describe("the stats popover", () => {
  it("colours the ring at 80% used and again at 95%, and never without a number", () => {
    expect([79, 80, 94, 95, 100, null].map(ringLevel)).toEqual(["ok", "notice", "notice", "full", "full", "ok"]);
    expect(costText(1.84)).toBe("$1.84");
    expect(costText(0)).toBe("$0.00");
    expect(costText(null)).toBe("—");
    expect(usedPercent(statsOf(84_000, 1.84))).toBe(42);
    expect(usedPercent(null)).toBeNull();
  });

  it("draws the ring's share, its level and the cost beside it", async () => {
    const renderer = await mount(statsOf(168_000, 1.84), () => Promise.resolve(null));

    expect(ring(renderer).props.className).toBe("ctx-ring is-notice");
    expect(ring(renderer).props["aria-label"]).toBe("Context: 84% used");
    expect(renderer.root.findByProps({ className: "ctx-cost" }).children).toEqual(["$1.84"]);
  });

  it("reads the numbers when it opens, and fills them in as Pi answers", async () => {
    const piRpc = mock((_command: PiRpcCommand) => Promise.resolve({}));
    const renderer = await mount(null, piRpc);
    await open(renderer);

    expect(piRpc).toHaveBeenCalledWith({ type: "get_session_stats" });
    // nothing yet: em-dashes, never a zero the reader would take for the answer
    expect(textOf(renderer, "ctx-amount")).toBe("— / —");
    expect(textOf(renderer, "ctx-percent")).toBe("—");
    expect(renderer.root.findAllByProps({ className: "ctx-title" })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ "aria-busy": true })).toHaveLength(1);
  });

  it("says a new session is empty, and what it has spent", async () => {
    const renderer = await mount({ ...statsOf(0, 0), contextUsage: { tokens: 0, contextWindow: 200_000, percent: 0 } }, () => Promise.resolve(null));
    await open(renderer);

    expect(textOf(renderer, "ctx-amount")).toBe("0 / 200k");
    expect(textOf(renderer, "ctx-percent")).toBe("0%");
    const shown = words(renderer);
    expect(shown).toContain("$0.00");
    expect(shown).toContain("↑ 1.2M in · ↓ 98k out");
    expect(shown).toContain("800k read · 40k written");
  });

  it("says why the usage could not be read, and asks again", async () => {
    const piRpc = mock((_command: PiRpcCommand) => Promise.reject(new ApiError("/api/pi/rpc", 502, "pi has exited", "rpc_failed")));
    const renderer = await mount(null, piRpc);
    await open(renderer);

    expect(words(renderer)).toContain("Couldn't read usage");
    const retry = renderer.root.findByProps({ className: "btn ctx-retry" });
    await act(async () => { retry.props.onClick(); });
    expect(piRpc.mock.calls.filter(([command]) => (command as PiRpcCommand).type === "get_session_stats")).toHaveLength(2);
  });

  it("compacts through Pi, with the instructions when they are added", async () => {
    const piRpc = mock((_command: PiRpcCommand) => Promise.resolve({}));
    const renderer = await mount(statsOf(84_000, 1.84), piRpc);
    await open(renderer);

    // Compact now alone sends the command itself
    const compact = () => renderer.root.findByProps({ className: "btn ctx-compact" });
    await act(async () => { compact().props.onClick(); });
    expect(piRpc).toHaveBeenCalledWith({ type: "compact" });

    // the fold takes instructions, and they go with it
    await act(async () => { renderer.root.findByProps({ className: "ctx-toggle" }).props.onClick(); });
    const field = renderer.root.findByProps({ className: "input ctx-instructions" });
    await act(async () => { field.props.onChange({ currentTarget: { value: "keep the tests" } }); });
    await act(async () => { compact().props.onClick(); });
    expect(piRpc).toHaveBeenCalledWith({ type: "compact", customInstructions: "keep the tests" });
  });

  it("keeps the popover open when Pi refuses to compact, with Pi's sentence", async () => {
    const piRpc = mock((command: PiRpcCommand) => command.type === "compact"
      ? Promise.reject(new ApiError("/api/pi/rpc", 502, "Nothing to compact", "rpc_failed"))
      : Promise.resolve({}));
    const renderer = await mount(statsOf(84_000, 1.84), piRpc);
    await open(renderer);

    await act(async () => { renderer.root.findByProps({ className: "btn ctx-compact" }).props.onClick(); });

    expect(dialog(renderer)).toHaveLength(1);
    expect(words(renderer)).toContain("Couldn't compact: Nothing to compact");
  });

  it("warns that the context is nearly full at 95% used", async () => {    const renderer = await mount(statsOf(192_000, 1.84), () => Promise.resolve(null));
    await open(renderer);

    expect(ring(renderer).props.className).toBe("ctx-ring is-full");
    expect(words(renderer)).toContain("Context is nearly full");
  });

  it("turns a short arc on the ring while Pi compacts", async () => {
    const idle = await mount(statsOf(84_000, 1.84), () => Promise.resolve(null));
    expect(idle.root.findAllByProps({ className: "ctx-ring-busy" })).toHaveLength(0);

    const busy = await mount(statsOf(84_000, 1.84), () => Promise.resolve(null), { busy: true });
    expect(busy.root.findAllByProps({ className: "ctx-ring-busy" })).toHaveLength(1);
  });

  it("opens on a rested pointer, and Escape closes it before anything else takes it", async () => {
    const renderer = await mount(statsOf(84_000, 1.84), () => Promise.resolve(null));

    // a pointer that merely crosses the ring opens nothing
    await act(async () => { ring(renderer).props.onPointerEnter(); });
    await act(async () => { ring(renderer).props.onPointerLeave(); });
    // fixed wait: the delayed open that must not arrive
    await act(async () => { await Bun.sleep(HOVER_OPEN_MS + 50); });
    expect(dialog(renderer)).toHaveLength(0);

    // one that rests on it does
    await act(async () => { ring(renderer).props.onPointerEnter(); });
    await until(() => dialog(renderer).length === 1, "a rested pointer never opened the popover");

    // it stays open while the pointer is inside it, and closes after it leaves
    await act(async () => { ring(renderer).props.onPointerLeave(); });
    await act(async () => { dialog(renderer)[0]!.props.onPointerEnter(); });
    // fixed wait: the close delay that must not run while the pointer is inside the popover
    await act(async () => { await Bun.sleep(HOVER_CLOSE_MS + 50); });
    expect(dialog(renderer)).toHaveLength(1);

    // Escape closes it and stops there: the composer's own Escape never runs, so no run is stopped
    let stopped = false;
    sendWindowEvent("keydown", { key: "Escape", preventDefault() {}, stopPropagation() { stopped = true; } });
    await act(async () => {});
    expect(dialog(renderer)).toHaveLength(0);
    expect(stopped).toBe(true);
  });
});
