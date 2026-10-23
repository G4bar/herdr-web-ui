import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as reactDom from "react-dom";
import TestRenderer, { act } from "react-test-renderer";

import { ApiError, type PiRpcCommand } from "../lib/api.ts";
import * as actualApi from "../lib/api.ts";
import { SHEET_QUERY } from "../lib/sheets.ts";
import { SettingsProvider } from "../lib/settings.ts";

/** every write Save as default sent */
const writes: Record<string, string | readonly string[]>[] = [];

// the menu is a portal so a transformed composer cannot clip it; the test renders it where it is
mock.module("react-dom", () => ({ ...reactDom, createPortal: (node: unknown) => node }));
// Save as default writes Pi's settings file
mock.module("../lib/api.ts", () => ({
  ...actualApi,
  fetchPiSettings: async () => ({ path: "/home/dev/.pi/agent/settings.json", settings: {} }),
  savePiSettings: async (changes: Record<string, string | readonly string[]>) => {
    writes.push(changes);
    return { path: "/home/dev/.pi/agent/settings.json", settings: changes };
  },
}));
const { PiThinkingMenu, PiPips, orderedLevels } = await import("./PiThinkingMenu.tsx");

const browserGlobals = ["window", "document", "HTMLElement", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "getComputedStyle"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
// the menu's words go through useT, which reads the browser's languages
const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
/** a card at sheet width, for the test that opens the phone's form */
let sheetMode = false;

beforeAll(() => {
  for (const name of browserGlobals) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const store = new Map<string, string>();
  // only the sheet query answers true, and only where a test asked for the sheet
  const media = (query: string) => ({ matches: sheetMode && query === SHEET_QUERY, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  const localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: (query: string) => media(query), getSelection: () => null, addEventListener() {}, removeEventListener() {}, localStorage,
    innerWidth: 1280, innerHeight: 800, requestAnimationFrame: (run: () => void) => setTimeout(run, 0), cancelAnimationFrame: () => {},
    // the sheet is a history entry (sheetHistory.ts) and keeps the address it opened on
    history: { state: null as unknown, pushState(state: unknown) { this.state = state; }, replaceState(state: unknown) { this.state = state; }, back() {} },
    location: { href: "http://localhost/" },
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    addEventListener() {}, removeEventListener() {}, activeElement: null, body: {}, querySelector: () => null,
    getElementById: () => null, getSelection: () => null,
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, lang: "", colorScheme: "" },
  } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  // the sheet's focus trap reads document.activeElement against it
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

const answers = (levels: unknown) => mock((_command: PiRpcCommand) => Promise.resolve(levels));

const mount = async (piRpc: (command: PiRpcCommand) => Promise<unknown>, props: Record<string, unknown> = {}) => {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(SettingsProvider, {
      children: createElement(PiThinkingMenu, { level: "high", piRpc, ...props }),
    }));
  });
  return renderer!;
};

const chip = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findByProps({ className: "pi-chip" });
const rows = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findAllByProps({ role: "menuitemradio" });

/** Every text a reader sees, in order, for the assertions below. */
const words = (renderer: TestRenderer.ReactTestRenderer): string[] =>
  renderer.root.findAll((node) => typeof node.type === "string").flatMap((node) => (node.children ?? []).filter((child): child is string => typeof child === "string"));

const open = async (renderer: TestRenderer.ReactTestRenderer): Promise<void> => {
  await act(async () => { chip(renderer).props.onClick(); });
  await act(async () => {});
};

describe("the thinking menu", () => {
  it("lists the levels Pi offers high to low, and marks the pane's own", async () => {
    const piRpc = answers({ levels: ["off", "low", "high", "max"] });
    const renderer = await mount(piRpc);
    await open(renderer);

    expect(piRpc).toHaveBeenCalledWith({ type: "get_available_thinking_levels" });
    expect(rows(renderer).map((row) => row.findAllByProps({ className: "pi-thinking-word" })[0]!.children.join(""))).toEqual(["Max", "High", "Low", "Off"]);
    const chosen = rows(renderer).filter((row) => row.props["aria-checked"] === true);
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.findAllByProps({ className: "pi-thinking-word" })[0]!.children.join("")).toBe("High");
  });

  it("leaves out a level the model does not offer, and one Pi does not know", async () => {
    const renderer = await mount(answers({ levels: ["off", "high", "nonsense"] }));
    await open(renderer);

    const shown = words(renderer);
    expect(shown).toContain("High");
    expect(shown).toContain("Off");
    for (const absent of ["Minimal", "Low", "Medium", "Extra high", "Max", "nonsense"]) expect(shown).not.toContain(absent);
    // Pi's set is closed: what it answers with is cut to it, in its order, high first
    expect(orderedLevels({ levels: ["low", "max", "bogus"] })).toEqual(["max", "low"]);
    expect(orderedLevels(null)).toEqual([]);
  });

  it("sets the level on a pick, closes, and puts the focus back in the message box", async () => {
    const onPicked = mock(() => {});
    const piRpc = answers({ levels: ["off", "high"] });
    const renderer = await mount(piRpc, { onPicked });
    await open(renderer);

    const lowRow = rows(renderer).find((row) => row.findAllByProps({ className: "pi-thinking-word" })[0]!.children.join("") === "Off")!;
    await act(async () => { lowRow.props.onClick(); });

    expect(piRpc).toHaveBeenCalledWith({ type: "set_thinking_level", level: "off" });
    expect(renderer.root.findAllByProps({ role: "menu" })).toHaveLength(0);
    expect(onPicked).toHaveBeenCalledTimes(1);
  });

  it("keeps the menu open and says why when Pi refuses the switch", async () => {
    const piRpc = mock((command: PiRpcCommand): Promise<unknown> => command.type === "set_thinking_level"
      ? Promise.reject(new ApiError("/api/pi/rpc", 502, "Thinking level not supported for this model", "rpc_failed"))
      : Promise.resolve({ levels: ["off", "high"] }));
    const renderer = await mount(piRpc);
    await open(renderer);

    await act(async () => { rows(renderer)[1]!.props.onClick(); });

    // the chip still draws the level Pi kept, and the menu it stayed open on carries the sentence
    expect(chip(renderer).findAllByProps({ className: "pi-chip-level" })[0]!.children.join("")).toBe("High");
    expect(renderer.root.findAllByProps({ role: "menu" })).toHaveLength(1);
    expect(words(renderer)).toContain("Couldn't switch: Thinking level not supported for this model");
  });

  it("says Thinking off and cannot be pressed when the model does not think", async () => {
    const piRpc = answers({ levels: ["off"] });
    const renderer = await mount(piRpc, { unsupported: true });

    expect(chip(renderer).findAllByProps({ className: "pi-chip-level" })[0]!.children.join("")).toBe("Thinking off");
    expect(chip(renderer).props["aria-disabled"]).toBe(true);
    expect(chip(renderer).props.title).toBe("This model doesn't think");
    await open(renderer);
    expect(piRpc).not.toHaveBeenCalled();
  });

  it("runs a sheet's keys once: one arrow is one row, and Enter is one pick", async () => {
    // the phone's form: the list holds the keys, and the sheet around it holds none, or each runs twice
    sheetMode = true;
    try {
      const piRpc = answers({ levels: ["off", "high"] });
      const renderer = await mount(piRpc);
      await open(renderer);

      const dialog = renderer.root.findByProps({ role: "dialog" });
      expect(dialog.props.onKeyDown).toBeUndefined();
      const menus = renderer.root.findAll((node) => typeof node.type === "string" && node.props.role === "menu");
      expect(menus).toHaveLength(1);
      const key = async (name: string): Promise<void> => {
        await act(async () => { menus[0]!.props.onKeyDown({ key: name, preventDefault() {}, stopPropagation() {} }); });
      };
      const active = (): number => rows(renderer).findIndex((row) => row.props["data-active"] === true);

      // it opens on the pane's own level, High, the top of the two offered
      expect(active()).toBe(0);
      await key("ArrowDown");
      expect(active()).toBe(1);
      await key("Enter");

      const picks = piRpc.mock.calls.filter((call) => call[0].type === "set_thinking_level");
      expect(picks).toHaveLength(1);
      expect(picks[0]![0]).toEqual({ type: "set_thinking_level", level: "off" });
    } finally {
      sheetMode = false;
    }
  });

  it("saves the highlighted level as the default, from the footer's button and from Ctrl+S", async () => {
    const onSavedAsDefault = mock(() => {});
    writes.length = 0;
    const renderer = await mount(answers({ levels: ["off", "high"] }), { onSavedAsDefault });
    await open(renderer);

    // the list opens on High, the top of the two; a move is not a pick
    await act(async () => { rows(renderer)[1]!.props.onPointerEnter(); });
    await act(async () => { renderer.root.findByProps({ className: "btn pi-thinking-save" }).props.onClick(); });
    expect(writes[0]).toEqual({ defaultThinkingLevel: "off" });
    expect(onSavedAsDefault).toHaveBeenCalledTimes(1);

    // Ctrl+S is the menu's while it is open: the browser's save page never runs
    await act(async () => { rows(renderer)[0]!.props.onPointerEnter(); });
    let prevented = 0;
    const key = (): Record<string, unknown> => ({ key: "s", ctrlKey: true, altKey: false, metaKey: false, preventDefault: () => { prevented += 1; } });
    await act(async () => { renderer.root.findByProps({ role: "menu" }).props.onKeyDown(key()); });
    expect(prevented).toBe(1);
    expect(writes[1]).toEqual({ defaultThinkingLevel: "high" });
    expect(onSavedAsDefault).toHaveBeenCalledTimes(2);
  });

  it("leaves a footer button's Enter and arrows to the button", async () => {
    const piRpc = answers({ levels: ["off", "high"] });
    const renderer = await mount(piRpc);
    await open(renderer);
    const menu = renderer.root.findByProps({ role: "menu" });
    // a key pressed on the footer's Save as default, bubbling up to the menu that holds it
    const save = { closest: (selector: string) => selector === ".pi-thinking-footer" ? save : null };
    const active = (): number => rows(renderer).findIndex((row) => row.props["data-active"] === true);
    const press = async (event: Record<string, unknown>): Promise<number> => {
      let prevented = 0;
      await act(async () => { menu.props.onKeyDown({ target: save, preventDefault: () => { prevented += 1; }, ...event }); });
      return prevented;
    };

    expect(await press({ key: "Enter" })).toBe(0);
    expect(piRpc.mock.calls.filter((call) => call[0].type === "set_thinking_level")).toHaveLength(0);
    expect(await press({ key: "ArrowDown" })).toBe(0);
    expect(active()).toBe(0);
    await act(async () => { renderer.unmount(); });
  });

  it("draws a level as five bars, lit to its height", () => {
    // each renderer is held for as long as its bars are read: React unmounts one nobody refers to
    const pips = (level: string): TestRenderer.ReactTestRenderer => {
      let renderer: TestRenderer.ReactTestRenderer | null = null;
      act(() => { renderer = TestRenderer.create(createElement(PiPips, { level })); });
      return renderer!;
    };
    const bars = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(pips);
    expect(bars.map((renderer) => renderer.root.findAllByProps({ className: "is-lit" }).length)).toEqual([0, 1, 2, 3, 4, 5, 5]);
    // Pi's max is the top of a five-bar ramp, drawn in xhigh's colour
    const max = bars[6]!.root.findByProps({ className: "pi-pips" });
    expect(max.props["data-level"]).toBe("xhigh");
    expect(max.props["aria-hidden"]).toBe("true");
  });
});
