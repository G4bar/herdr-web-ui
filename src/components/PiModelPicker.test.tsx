import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as reactDom from "react-dom";
import TestRenderer, { act } from "react-test-renderer";

import { ApiError, type PiRpcCommand } from "../lib/api.ts";
import * as actualApi from "../lib/api.ts";
import { SettingsProvider } from "../lib/settings.ts";

/** the models Pi's settings file scopes the cycle to; null: it scopes none, so every model cycles */
let scoped: string[] | null = null;
/** every write Save as default sent */
const writes: Record<string, string | readonly string[]>[] = [];

// the picker is a portal so a transformed composer cannot clip it; the test renders it where it is
mock.module("react-dom", () => ({ ...reactDom, createPortal: (node: unknown) => node }));
// the picker reads the cycle from Pi's settings file, and writes the default there
mock.module("../lib/api.ts", () => ({
  ...actualApi,
  fetchPiSettings: async () => ({ path: "/home/dev/.pi/agent/settings.json", settings: scoped === null ? {} : { enabledModels: scoped } }),
  savePiSettings: async (changes: Record<string, string | readonly string[]>) => {
    writes.push(changes);
    return { path: "/home/dev/.pi/agent/settings.json", settings: changes };
  },
}));
const { PiModelPicker, groupModels, piModels } = await import("./PiModelPicker.tsx");

const MODELS = {
  models: [
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", reasoning: true, input: ["text", "image"], contextWindow: 200000 },
    { id: "claude-opus-4-1", name: "Claude Opus 4.1", provider: "anthropic", reasoning: true, input: ["text"], contextWindow: 200000 },
    { id: "gpt-5", name: "GPT-5", provider: "openai", reasoning: false, input: ["text"], contextWindow: 400000 },
  ],
};

const browserGlobals = ["window", "document", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "getComputedStyle"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
// the picker's words go through useT, which reads the browser's languages
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

const mount = async (piRpc: (command: PiRpcCommand) => Promise<unknown>, props: Record<string, unknown> = {}) => {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(SettingsProvider, {
      children: createElement(PiModelPicker, {
        label: "Claude Sonnet 4.5",
        current: { provider: "anthropic", id: "claude-sonnet-4-5" },
        piRpc,
        ...props,
      }),
    }));
  });
  return renderer!;
};

const chip = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findByProps({ className: "pi-chip" });

const answers = (models: unknown) => mock(() => Promise.resolve(models));

/** Every text a reader sees, in order, for the assertions below. */
const words = (renderer: TestRenderer.ReactTestRenderer): string[] =>
  renderer.root.findAll((node) => typeof node.type === "string").flatMap((node) => (node.children ?? []).filter((child): child is string => typeof child === "string"));

describe("the model picker", () => {
  it("groups the models by provider and marks the pane's own", async () => {
    const piRpc = answers(MODELS);
    const renderer = await mount(piRpc);
    await act(async () => { chip(renderer).props.onClick(); });
    await act(async () => {});

    expect(piRpc).toHaveBeenCalledWith({ type: "get_available_models" });
    expect(renderer.root.findAllByProps({ className: "menu-heading" }).map((node) => node.children.join(""))).toEqual(["anthropic", "openai"]);
    const selected = renderer.root.findAllByProps({ role: "option" }).filter((node) => node.props["aria-selected"] === true);
    expect(selected).toHaveLength(1);
    expect(words(renderer)).toContain("Claude Sonnet 4.5");
    // the row says what it is worth in words, not only in a glyph
    expect(words(renderer)).toContain("200k context · thinking · images");
  });

  it("keeps what the search matches and says so when nothing does", async () => {
    const renderer = await mount(answers(MODELS));
    await act(async () => { chip(renderer).props.onClick(); });
    await act(async () => {});
    const search = renderer.root.findByProps({ className: "input pi-picker-search" });

    await act(async () => { search.props.onChange({ target: { value: "gpt" } }); });
    expect(renderer.root.findAllByProps({ role: "option" })).toHaveLength(1);
    expect(words(renderer)).toContain("GPT-5");

    await act(async () => { search.props.onChange({ target: { value: "gpt-9" } }); });
    expect(renderer.root.findAllByProps({ role: "option" })).toHaveLength(0);
    expect(words(renderer)).toContain("No model matches \"gpt-9\"");
  });

  it("keeps the list open on the row a refused switch was about", async () => {
    const piRpc = mock((command: PiRpcCommand): Promise<unknown> => command.type === "set_model"
      ? Promise.reject(new ApiError("/api/pi/rpc", 502, "Model not found: invalid/model", "rpc_failed"))
      : Promise.resolve(MODELS));
    const renderer = await mount(piRpc);
    await act(async () => { chip(renderer).props.onClick(); });
    await act(async () => {});
    const rows = renderer.root.findAllByProps({ role: "option" });

    await act(async () => { rows[0]!.props.onClick(); });

    expect(piRpc).toHaveBeenCalledWith({ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-5" });
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(words(renderer)).toContain("Couldn't switch: Model not found: invalid/model");
  });

  it("offers the cycle beside the whole list only when Pi scopes one, and splits the rows by it", async () => {
    scoped = ["anthropic/claude-sonnet-4-5"];
    try {
      const renderer = await mount(answers(MODELS));
      await act(async () => { chip(renderer).props.onClick(); });
      await act(async () => {});

      const modes = renderer.root.findByProps({ className: "segmented pi-picker-modes" });
      const buttons = modes.findAll((node) => node.type === "button");
      expect(buttons.map((button) => button.children.join(""))).toEqual(["Scoped 1", "All 3"]);
      expect(buttons[1]!.props["aria-pressed"]).toBe(true);

      await act(async () => { buttons[0]!.props.onClick(); });
      const options = renderer.root.findAllByProps({ role: "option" });
      expect(options).toHaveLength(1);
      expect(options[0]!.findAllByProps({ className: "pi-picker-name" })[0]!.children.join("")).toBe("Claude Sonnet 4.5");
      await act(async () => { renderer.unmount(); });
    } finally {
      scoped = null;
    }

    // a file that scopes nothing names no second list: the footer is Save as default alone
    const plain = await mount(answers(MODELS));
    await act(async () => { chip(plain).props.onClick(); });
    await act(async () => {});
    expect(plain.root.findAllByProps({ className: "segmented pi-picker-modes" })).toHaveLength(0);
    expect(plain.root.findByProps({ className: "btn pi-picker-save" })).toBeTruthy();
  });

  it("saves the highlighted model as the default, from the footer's button and from Ctrl+S", async () => {
    const onSavedAsDefault = mock(() => {});
    writes.length = 0;
    const renderer = await mount(answers(MODELS), { onSavedAsDefault });
    await act(async () => { chip(renderer).props.onClick(); });
    await act(async () => {});

    await act(async () => { renderer.root.findAllByProps({ role: "option" })[1]!.props.onPointerEnter(); });
    await act(async () => { renderer.root.findByProps({ className: "btn pi-picker-save" }).props.onClick(); });
    expect(writes[0]).toEqual({ defaultProvider: "anthropic", defaultModel: "claude-opus-4-1" });
    expect(onSavedAsDefault).toHaveBeenCalledTimes(1);

    // Ctrl+S is the picker's while it is open: the browser's save page never runs
    const dialog = renderer.root.findByProps({ className: "menu pi-picker" });
    await act(async () => { renderer.root.findAllByProps({ role: "option" })[2]!.props.onPointerEnter(); });
    let prevented = 0;
    await act(async () => { dialog.props.onKeyDown({ key: "s", ctrlKey: true, altKey: false, metaKey: false, preventDefault: () => { prevented += 1; } }); });
    expect(prevented).toBe(1);
    expect(writes[1]).toEqual({ defaultProvider: "openai", defaultModel: "gpt-5" });
    expect(onSavedAsDefault).toHaveBeenCalledTimes(2);
  });

  it("counts a glob and a suffixed entry as the models they name", async () => {
    scoped = ["anthropic/claude*", "openai/gpt-5:high"];
    try {
      const renderer = await mount(answers(MODELS));
      await act(async () => { chip(renderer).props.onClick(); });
      await act(async () => {});

      const buttons = renderer.root.findByProps({ className: "segmented pi-picker-modes" }).findAll((node) => node.type === "button");
      expect(buttons.map((button) => button.children.join(""))).toEqual(["Scoped 3", "All 3"]);
      await act(async () => { renderer.unmount(); });
    } finally {
      scoped = null;
    }

    // only a thinking level is a suffix: `:free` is part of the id, so an exact entry still counts
    scoped = ["openrouter/x/y:free"];
    try {
      const free = { models: [{ id: "x/y:free", name: "Free", provider: "openrouter", reasoning: false, input: ["text"], contextWindow: null }] };
      const renderer = await mount(answers(free));
      await act(async () => { chip(renderer).props.onClick(); });
      await act(async () => {});

      const buttons = renderer.root.findByProps({ className: "segmented pi-picker-modes" }).findAll((node) => node.type === "button");
      expect(buttons.map((button) => button.children.join(""))).toEqual(["Scoped 1", "All 1"]);
      await act(async () => { renderer.unmount(); });
    } finally {
      scoped = null;
    }
  });

  it("leaves a footer button's Enter, arrows and Ctrl+S to the button", async () => {
    const onSavedAsDefault = mock(() => {});
    writes.length = 0;
    const piRpc = mock((_command: PiRpcCommand) => Promise.resolve(MODELS));
    const renderer = await mount(piRpc, { onSavedAsDefault });
    await act(async () => { chip(renderer).props.onClick(); });
    await act(async () => {});
    const dialog = renderer.root.findByProps({ className: "menu pi-picker" });
    // a key pressed on the footer's Save as default, bubbling up to the popover that holds it
    const save = { closest: (selector: string) => selector === ".pi-picker-footer" ? save : null };
    const active = (): number => renderer.root.findAllByProps({ role: "option" }).findIndex((row) => row.props["data-active"] === true);
    const press = async (event: Record<string, unknown>): Promise<number> => {
      let prevented = 0;
      await act(async () => { dialog.props.onKeyDown({ target: save, preventDefault: () => { prevented += 1; }, ...event }); });
      return prevented;
    };

    expect(await press({ key: "Enter" })).toBe(0);
    expect(piRpc.mock.calls.filter((call) => call[0].type === "set_model")).toHaveLength(0);
    expect(await press({ key: "ArrowDown" })).toBe(0);
    expect(active()).toBe(0);
    // Ctrl+S is the picker's wherever the focus is in it
    expect(await press({ key: "s", ctrlKey: true })).toBe(1);
    expect(writes[0]).toEqual({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5" });
    expect(onSavedAsDefault).toHaveBeenCalledTimes(1);
    await act(async () => { renderer.unmount(); });
  });

  it("reads Pi's list into rows, and groups it in the order Pi gave", () => {
    const models = piModels(MODELS);
    expect(models.map((model) => model.id)).toEqual(["claude-sonnet-4-5", "claude-opus-4-1", "gpt-5"]);
    expect(groupModels(models, "opus").map((group) => group.provider)).toEqual(["anthropic"]);
    expect(piModels({}).length).toBe(0);
  });
});
