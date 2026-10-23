import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as reactDom from "react-dom";
import TestRenderer, { act } from "react-test-renderer";

import { initialPiNativeState } from "../../server/pi-rpc.ts";
import type { PiNativeState, PiNativeWidget } from "../../shared/protocol.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { PiRpcCommand } from "../lib/api.ts";

// a picker for a native pane's model opens in a portal; nothing here opens it, and SSR has no DOM to put it in
mock.module("react-dom", () => ({ ...reactDom, createPortal: (node: unknown) => node }));
const { Composer } = await import("./Composer.tsx");

const browserGlobals = ["window", "document", "HTMLElement", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame", "cancelAnimationFrame"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");

let drafts = 0;

beforeAll(() => {
  for (const name of browserGlobals) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const store = new Map<string, string>();
  const localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) };
  const media = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: (query: string) => media(query), getSelection: () => null, addEventListener() {}, removeEventListener() {}, localStorage,
    innerWidth: 1280, innerHeight: 800, requestAnimationFrame: (run: () => void) => setTimeout(run, 0), cancelAnimationFrame: () => {},
    setInterval: (run: () => void, ms: number) => setInterval(run, ms), clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    history: { state: null as unknown, pushState(state: unknown) { this.state = state; }, replaceState(state: unknown) { this.state = state; }, back() {} },
    location: { href: "http://localhost/" },
  } });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (run: () => void) => setTimeout(run, 0) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
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

const native = (extra: Partial<PiNativeState> = {}): PiNativeState => ({ ...initialPiNativeState(), mode: "native", ...extra });
const widget = (lines: string[], placement: PiNativeWidget["placement"] = "aboveEditor"): PiNativeWidget => ({ lines, placement });

/** A native Pi's composer over a draft, redrawn with whatever state the test pushes next. */
async function mount(options: { draft: string; piNative?: PiNativeState }) {
  const id = `widget${++drafts}`;
  const draftKey = `ovis:composer-draft:${id}`;
  composerDrafts.set(draftKey, options.draft);
  window.localStorage.setItem("ovis:settings", JSON.stringify({ enterSends: true }));
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  const tree = (state: PiNativeState) => createElement(SettingsProvider, {
    children: createElement(Composer, {
      connected: true, paneId: id, agent: "pi", agentStatus: "idle",
      piNative: state,
      piRpc: (_command: PiRpcCommand) => Promise.resolve(null),
      onSend: () => true,
      onAbort: () => undefined,
      onUploadImage: async () => "",
    }),
  });
  await act(async () => { renderer = TestRenderer.create(tree(options.piNative ?? native())); });
  // the effects a mount leaves behind (a first command read, a redraw frame) settle here, not mid-assertion
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const root = renderer!.root;
  return {
    draft: () => root.findByProps({ className: "composer-text" }).props.value as string,
    /** the lines of every widget card, in the order they are drawn */
    widgets: () => root.findAll((node) => typeof node.props.className === "string" && node.props.className.split(" ").includes("composer-widget"))
      .map((node) => ({ text: node.props.children as string, below: node.props.className.split(" ").includes("is-below") })),
    /** the pane's live state moved on: the same composer, drawn again */
    update: async (state: PiNativeState) => { await act(async () => { renderer!.update(tree(state)); }); },
    unmount: async () => { await act(async () => { renderer!.unmount(); }); },
  };
}

describe("an extension's widget", () => {
  it("stands over the card, or under it where the extension asked, at most six lines each", async () => {
    const composer = await mount({ draft: "", piNative: native({ widgets: {
      above: widget(["Plan 2/5", "Read the router"]),
      below: widget(["42 tokens/s"], "belowEditor"),
      long: widget(Array.from({ length: 9 }, (_, index) => `line ${index}`)),
    } }) });

    const drawn = composer.widgets();
    // the two over the card first, in the order they were drawn, then the one under it
    expect(drawn.map((row) => row.below)).toEqual([false, false, true]);
    expect(drawn[0]?.text).toBe("Plan 2/5\nRead the router");
    expect(drawn[1]?.text.split("\n")).toHaveLength(6);
    expect(drawn[2]?.text).toBe("42 tokens/s");
    await composer.unmount();
  });
});

describe("set_editor_text", () => {
  it("fills an empty box once and leaves the next push of the same text alone", async () => {
    const composer = await mount({ draft: "", piNative: native({ editorText: "explain the diff" }) });
    expect(composer.draft()).toBe("explain the diff");

    // the same value still in the state, pushed again: the box is not filled a second time
    await composer.update(native({ editorText: "explain the diff" }));
    expect(composer.draft()).toBe("explain the diff");

    // a new one is applied, and it goes on a line under whatever the user already had
    await composer.update(native({ editorText: "and the tests" }));
    expect(composer.draft()).toBe("explain the diff\nand the tests");
    await composer.unmount();
  });

  it("never replaces a draft the user is holding", async () => {
    const composer = await mount({ draft: "my own words", piNative: native({ editorText: "theirs" }) });
    expect(composer.draft()).toBe("my own words\ntheirs");
    await composer.unmount();
  });

  it("fills the same text again once the state has let it go", async () => {
    const composer = await mount({ draft: "", piNative: native({ editorText: "run the tests" }) });
    expect(composer.draft()).toBe("run the tests");

    // the prefill was consumed and the box cleared: sending the very same text again fills it
    await composer.update(native({ editorText: null }));
    await composer.update(native({ editorText: "run the tests" }));
    expect(composer.draft()).toBe("run the tests\nrun the tests");
    await composer.unmount();
  });
});
