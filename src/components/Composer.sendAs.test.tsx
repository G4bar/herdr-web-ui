import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as reactDom from "react-dom";
import TestRenderer, { act } from "react-test-renderer";

import { initialPiNativeState } from "../../server/pi-rpc.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { SettingsProvider } from "../lib/settings.ts";

// a picker for a native pane's model opens in a portal; nothing here opens it, and SSR has no DOM to put it in
mock.module("react-dom", () => ({ ...reactDom, createPortal: (node: unknown) => node }));
const { Composer } = await import("./Composer.tsx");

const browserGlobals = ["window", "document", "HTMLElement", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame", "cancelAnimationFrame"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");

const DRAFT = "ovis:composer-draft:p1";

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

const streaming = { ...initialPiNativeState(), mode: "native" as const, isStreaming: true };

/** A native Pi's composer over a draft. `onSend` records its arguments; the row is what is drawn. */
async function mount(options: { draft: string; piNative: typeof streaming | null; agentStatus?: "idle" | "working" }) {
  composerDrafts.set(DRAFT, options.draft);
  const sent: Array<{ text: string; deliver?: string }> = [];
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(SettingsProvider, {
      children: createElement(Composer, {
        connected: true, paneId: "p1", agent: "pi", agentStatus: options.agentStatus ?? (options.piNative?.isStreaming ? "working" : "idle"),
        piNative: options.piNative, piRpc: async () => null,
        onSend: (text: string, _clearDraft?: string, _sendAnyway?: boolean, deliver?: string) => { sent.push({ text, deliver }); return true; },
        onAbort: () => {}, onUploadImage: async () => "",
      }),
    }));
    // the effects a mount leaves behind (a first command read, a redraw frame) settle here, not mid-assertion
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  });
  const root = renderer!.root;
  const hasClass = (name: string) => (node: TestRenderer.ReactTestInstance) =>
    typeof node.props.className === "string" && node.props.className.split(" ").includes(name);
  return {
    row: () => root.findAll(hasClass("composer-send-as")).length,
    modes: () => root.findAll(hasClass("composer-send-as-modes")).flatMap((node) => node.findAllByType("button")),
    empty: () => root.findAll(hasClass("composer-stop")).length > 0,
    type: async (key: string, extra: Record<string, unknown> = {}) => {
      const event = { key, altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, preventDefault() {}, nativeEvent: { isComposing: false, keyCode: 13 }, ...extra };
      await act(async () => { root.findByProps({ className: "composer-text" }).props.onKeyDown(event); });
    },
    sent,
  };
}

describe("the Send-as row", () => {
  it("shows over the box only while Pi runs and there is something to send", async () => {
    const running = await mount({ draft: "also check the migration", piNative: streaming });
    expect(running.row()).toBe(1);
    expect(running.modes().map((button) => button.props.children)).toEqual(["Steer", "Follow-up"]);
    // a Pi that is not running keeps the plain box: there is no queue to steer
    expect((await mount({ draft: "hello", piNative: null })).row()).toBe(0);
    // and an empty box while it runs is Stop, not a mode, even on a pane whose agent status lags
    const empty = await mount({ draft: "", piNative: streaming, agentStatus: "idle" });
    expect(empty.row()).toBe(0);
    expect(empty.empty()).toBe(true);
  });

  it("sends Enter as the chosen mode, and Alt+Enter always as a follow-up", async () => {
    // a send that goes clears the box, so each key is pressed in a composer of its own
    const enter = await mount({ draft: "steer me", piNative: streaming });
    await enter.type("Enter");
    expect(enter.sent).toEqual([{ text: "steer me", deliver: "steer" }]);

    const alt = await mount({ draft: "steer me", piNative: streaming });
    await alt.type("Enter", { altKey: true });
    expect(alt.sent).toEqual([{ text: "steer me", deliver: "followUp" }]);

    const picked = await mount({ draft: "steer me", piNative: streaming });
    await act(async () => { picked.modes().find((button) => button.props.children === "Follow-up")!.props.onClick(); });
    await picked.type("Enter");
    expect(picked.sent).toEqual([{ text: "steer me", deliver: "followUp" }]);
  });

  it("leaves another agent's send without a delivery kind", async () => {
    const enter = await mount({ draft: "hello", piNative: null });
    await enter.type("Enter");
    const alt = await mount({ draft: "hello", piNative: null });
    await alt.type("Enter", { altKey: true });
    expect([...enter.sent, ...alt.sent]).toEqual([{ text: "hello", deliver: undefined }, { text: "hello", deliver: undefined }]);
  });
});
