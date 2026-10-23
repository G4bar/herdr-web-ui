import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as reactDom from "react-dom";
import TestRenderer, { act } from "react-test-renderer";

import { ApiError, type PiRpcCommand } from "../lib/api.ts";
import { SettingsProvider } from "../lib/settings.ts";

// the menu is a portal so a transformed composer cannot clip it; the test renders it where it is
mock.module("react-dom", () => ({ ...reactDom, createPortal: (node: unknown) => node }));
const { PiThinkingMenu, PiPips, orderedLevels } = await import("./PiThinkingMenu.tsx");

const browserGlobals = ["window", "document", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "getComputedStyle"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
// the menu's words go through useT, which reads the browser's languages
const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });

beforeAll(() => {
  for (const name of browserGlobals) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const store = new Map<string, string>();
  const media = { matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false };
  const localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: () => media, getSelection: () => null, addEventListener() {}, removeEventListener() {}, localStorage,
    innerWidth: 1280, innerHeight: 800, requestAnimationFrame: (run: () => void) => setTimeout(run, 0), cancelAnimationFrame: () => {},
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    addEventListener() {}, removeEventListener() {}, activeElement: null, body: {}, querySelector: () => null,
    getElementById: () => null, getSelection: () => null,
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

const answers = (levels: unknown) => mock(() => Promise.resolve(levels));

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
