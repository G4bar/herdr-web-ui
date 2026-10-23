import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactElement } from "react";
import * as reactDom from "react-dom";
import TestRenderer, { act } from "react-test-renderer";

import * as actualApi from "../lib/api.ts";
import { SettingsProvider } from "../lib/settings.ts";

/** what the dialog asked the server to write */
const writes: { changes: Record<string, string | readonly string[]>; machineId: string }[] = [];
let failWith: Error | null = null;

// the dialog is a portal so a transformed page cannot clip it; the test renders it where it is
mock.module("react-dom", () => ({ ...reactDom, createPortal: (node: unknown) => node }));
mock.module("../lib/api.ts", () => ({
  ...actualApi,
  savePiSettings: async (changes: Record<string, string | readonly string[]>, machineId: string) => {
    if (failWith !== null) throw failWith;
    writes.push({ changes, machineId });
    return { path: "/home/dev/.pi/agent/settings.json", settings: changes };
  },
}));
const { ScopedModelsDialog } = await import("./ScopedModelsDialog.tsx");
const { ApiError } = actualApi;

const MODELS = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, images: true, contextWindow: 200000 },
  { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1", reasoning: true, images: false, contextWindow: 200000 },
  { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: false, images: false, contextWindow: 400000 },
];

const browserGlobals = ["window", "document", "HTMLElement", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "getComputedStyle"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
// the dialog's words go through useT, which reads the browser's languages
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
    history: { state: null as unknown, pushState(state: unknown) { this.state = state; }, replaceState(state: unknown) { this.state = state; }, back() {} },
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

beforeEach(() => {
  writes.length = 0;
  failWith = null;
});

let closed = 0;
let saved = 0;

const mount = async (scoped: readonly string[] | null, createNodeMock?: (element: ReactElement) => unknown) => {
  closed = 0;
  saved = 0;
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(SettingsProvider, {
      children: createElement(ScopedModelsDialog, {
        models: MODELS,
        scoped,
        machineId: "local",
        onSaved: () => { saved += 1; },
        onClose: () => { closed += 1; },
      }),
    }), createNodeMock === undefined ? undefined : { createNodeMock });
  });
  return renderer!;
};

/** Stands in for the arrows' own nodes (react-test-renderer hands refs null), so a test sees the focus. */
const focusOf = (focused: string[]) => (element: ReactElement): unknown =>
  element.type === "button" ? { focus: () => { focused.push(String((element.props as { "aria-label"?: string })["aria-label"])); } } : null;

const words = (renderer: TestRenderer.ReactTestRenderer): string[] =>
  renderer.root.findAll((node) => typeof node.type === "string").flatMap((node) => (node.children ?? []).filter((child): child is string => typeof child === "string"));
const box = (renderer: TestRenderer.ReactTestRenderer, name: string) => renderer.root.findAllByProps({ type: "checkbox" }).find((node) => node.props["aria-label"] === name)!;
const button = (renderer: TestRenderer.ReactTestRenderer, label: string) => renderer.root.findAll((node) => node.type === "button").find((node) => node.props["aria-label"] === label || (node.children as unknown[]).includes(label))!;
const arrow = (renderer: TestRenderer.ReactTestRenderer, name: string, label: string) => renderer.root
  .findAll((node) => node.type === "li" && node.props.className === "scoped-row" && node.findAllByProps({ "aria-label": name }).length > 0)
  .flatMap((row) => row.findAll((node) => node.type === "button"))
  .find((node) => node.props["aria-label"] === label)!;
/** the place each checked row shows, in the order the rows are drawn */
const places = (renderer: TestRenderer.ReactTestRenderer): string[] =>
  renderer.root.findAll((node) => node.type === "span" && node.props.className === "scoped-place").map((node) => node.children.join(""));
const press = async (node: { props: { onClick?: () => void } }) => { await act(async () => { node.props.onClick?.(); }); };
const ctrl = async (renderer: TestRenderer.ReactTestRenderer, key: string) => {
  await act(async () => {
    renderer.root.findByProps({ role: "dialog" }).props.onKeyDown({ key, ctrlKey: true, altKey: false, metaKey: false, preventDefault() {} });
  });
};

describe("the scoped models dialog", () => {
  it("lists Pi's models grouped by provider, every one checked when the file scopes nothing", async () => {
    const renderer = await mount(null);
    expect(words(renderer)).toContain("3 of 3 in the cycle");
    expect(box(renderer, "Claude Sonnet 4.5").props.checked).toBe(true);
    expect(renderer.root.findAllByProps({ role: "checkbox" }).map((node) => node.props["aria-checked"])).toEqual([true, true]);
  });

  it("reads the file's own scope, and a pattern it holds is written back untouched", async () => {
    const renderer = await mount(["anthropic/claude-sonnet-4-5", "openai/*"]);
    expect(words(renderer)).toContain("1 of 3 in the cycle");
    expect(box(renderer, "Claude Opus 4.1").props.checked).toBe(false);
    await act(async () => { box(renderer, "GPT-5").props.onChange(); });
    await press(button(renderer, "Save"));
    expect(writes).toEqual([{ changes: { enabledModels: ["anthropic/claude-sonnet-4-5", "openai/*", "openai/gpt-5"] }, machineId: "local" }]);
  });

  it("turns one provider by its group row, and the whole list by Ctrl+A and Ctrl+X", async () => {
    const renderer = await mount(["anthropic/claude-sonnet-4-5"]);
    // the anthropic group is half in, so its row puts the rest in
    await press(button(renderer, "anthropic"));
    expect(box(renderer, "Claude Opus 4.1").props.checked).toBe(true);
    await ctrl(renderer, "x");
    expect(box(renderer, "Claude Sonnet 4.5").props.checked).toBe(false);
    await ctrl(renderer, "a");
    expect(words(renderer)).toContain("3 of 3 in the cycle");
    await press(button(renderer, "Save"));
    expect(writes[0]?.changes).toEqual({ enabledModels: ["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-1", "openai/gpt-5"] });
  });

  it("orders the cycle with the arrows and with Alt+↑/↓, and saves that order", async () => {
    const renderer = await mount(["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-1", "openai/gpt-5"]);
    // the second row's own arrow takes it up one place
    await press(renderer.root.findAll((node) => node.type === "button").filter((node) => node.props["aria-label"] === "Move up")[1]!);
    // Alt+↓ on the first row's box is the keyboard's way to the same move
    await act(async () => {
      renderer.root.findAllByType("li").find((node) => node.props.className === "scoped-row" && node.findAllByProps({ "aria-label": "Claude Sonnet 4.5" }).length > 0)!
        .props.onKeyDown({ key: "ArrowDown", altKey: true, preventDefault() {} });
    });
    await press(button(renderer, "Save"));
    expect(writes).toEqual([{ changes: { enabledModels: ["anthropic/claude-opus-4-1", "openai/gpt-5", "anthropic/claude-sonnet-4-5"] }, machineId: "local" }]);
  });

  it("moves a model past the pattern between them, and hands the focus to an arrow that still works", async () => {
    const focused: string[] = [];
    const renderer = await mount(["anthropic/claude-sonnet-4-5", "openai/*", "openai/gpt-5"], focusOf(focused));
    // the number is the place in the cycle the arrows change: the pattern between them takes none
    expect(places(renderer)).toEqual(["1", "2"]);
    // GPT-5 goes past Sonnet across the pattern, never trading places with the pattern itself
    await press(arrow(renderer, "GPT-5", "Move up"));
    expect(places(renderer)).toEqual(["2", "1"]);
    // it is first now, so the arrow it was moved with is disabled: the row's other arrow takes the focus
    expect(focused).toEqual(["Move down"]);
    await press(button(renderer, "Save"));
    expect(writes).toEqual([{ changes: { enabledModels: ["openai/gpt-5", "openai/*", "anthropic/claude-sonnet-4-5"] }, machineId: "local" }]);
  });

  it("says every model is in the cycle once Clear all leaves nothing scoped, which is what Pi reads", async () => {
    const renderer = await mount(["anthropic/claude-sonnet-4-5"]);
    await ctrl(renderer, "x");
    expect(words(renderer)).toContain("Every model is in the cycle");
    expect(words(renderer)).not.toContain("0 of 3 in the cycle");
    await press(button(renderer, "Save"));
    expect(writes[0]?.changes).toEqual({ enabledModels: [] });
  });

  it("keeps the dialog open with the server's sentence when the write is refused", async () => {
    const renderer = await mount(["anthropic/claude-sonnet-4-5"]);
    failWith = new ApiError("/api/pi/settings", 409, "settings.json: not valid JSON", "invalid_settings_file");
    await press(button(renderer, "Save"));
    expect(closed).toBe(0);
    expect(saved).toBe(0);
    expect(renderer.root.findAllByProps({ role: "alert" }).map((node) => node.children.join(""))).toEqual(["Couldn't change Scoped models: settings.json: not valid JSON"]);
  });

  it("closes with Cancel and hands the new file on after a save", async () => {
    const renderer = await mount(["anthropic/claude-sonnet-4-5"]);
    await press(button(renderer, "Cancel"));
    expect([closed, saved]).toEqual([1, 0]);
    await press(button(renderer, "Save"));
    expect([closed, saved]).toEqual([2, 1]);
  });
});
