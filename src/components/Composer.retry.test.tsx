import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as reactDom from "react-dom";
import TestRenderer, { act } from "react-test-renderer";

import { initialPiNativeState } from "../../server/pi-rpc.ts";
import type { PiNativeState, PiNativeRetry } from "../../shared/protocol.ts";
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

const retry = (extra: Partial<PiNativeRetry> = {}): PiNativeRetry => ({ attempt: 2, maxAttempts: 3, delayMs: 4_000, errorMessage: "overloaded", ...extra });
const RETRY_LINE = "Provider error. Retrying in 4 s (2 of 3)";

/** A native Pi's composer over a draft, with the one RPC command it sends recorded. */
async function mount(options: { draft: string; piNative: PiNativeState }) {
  const draftKey = `ovis:composer-draft:retry${++drafts}`;
  composerDrafts.set(draftKey, options.draft);
  window.localStorage.setItem("ovis:settings", JSON.stringify({ enterSends: true }));
  const commands: PiRpcCommand[] = [];
  const aborts: number[] = [];
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(SettingsProvider, {
      children: createElement(Composer, {
        connected: true, paneId: `retry${drafts}`, agent: "pi", agentStatus: options.piNative.isStreaming ? "working" : "idle",
        piNative: options.piNative,
        piRpc: (command: PiRpcCommand) => { commands.push(command); return Promise.resolve(null); },
        onSend: () => true,
        onAbort: () => { aborts.push(Date.now()); },
        onUploadImage: async () => "",
      }),
    }));
    // the effects a mount leaves behind (a first command read, a redraw frame) settle here, not mid-assertion
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  });
  const root = renderer!.root;
  const hasClass = (name: string) => (node: TestRenderer.ReactTestInstance) =>
    typeof node.props.className === "string" && node.props.className.split(" ").includes(name);
  return {
    /** every string the card draws outside the transcript, for the notice and the status line */
    words: () => root.findAll((node) => typeof node.type === "string").flatMap((node) => (node.children ?? []).filter((child): child is string => typeof child === "string")),
    retryNotice: () => root.findAll(hasClass("composer-retry")).length,
    retryAction: () => root.findAllByProps({ className: "composer-note-action" }).find((node) => node.props.children === "Cancel retry") ?? null,
    /** what the persistent status region says (DS §8.3), which is the announcement */
    announced: () => root.findAllByProps({ role: "status" }).flatMap((node) => node.findAllByType("p")).flatMap((node) => node.children.filter((child): child is string => typeof child === "string")).join(""),
    press: async (key: string) => {
      const event = { key, altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, preventDefault() {}, nativeEvent: { isComposing: false, keyCode: 27, key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false } };
      await act(async () => { root.findByProps({ className: "composer-text" }).props.onKeyDown(event); });
    },
    commands,
    aborts,
    unmount: async () => { await act(async () => { renderer!.unmount(); }); },
  };
}

describe("the retry notice", () => {
  it("stands over the card with its seconds and stops the retry when asked", async () => {
    const composer = await mount({ draft: "", piNative: { ...initialPiNativeState(), mode: "native", retry: retry() } });

    expect(composer.retryNotice()).toBe(1);
    expect(composer.words()).toContain(RETRY_LINE);
    await act(async () => { composer.retryAction()!.props.onClick(); });
    expect(composer.commands).toEqual([{ type: "abort_retry" }]);
    // nothing is announced twice, and the notice is not a live region: its countdown is never read out
    expect(composer.announced()).toBe(RETRY_LINE);
    await composer.unmount();
  });

  it("draws nothing, and reads nothing, on a Pi that is not retrying", async () => {
    const composer = await mount({ draft: "", piNative: { ...initialPiNativeState(), mode: "native" } });

    expect(composer.retryNotice()).toBe(0);
    expect(composer.announced()).toBe("");
    await composer.unmount();
  });

  it("cancels the retry on Escape before the run behind it is stopped (DS §6.1)", async () => {
    const composer = await mount({ draft: "still here", piNative: { ...initialPiNativeState(), mode: "native", isStreaming: true, retry: retry() } });

    await composer.press("Escape");
    expect(composer.commands).toEqual([{ type: "abort_retry" }]);
    expect(composer.aborts).toEqual([]);
    await composer.unmount();
  });
});

describe("a compacting Pi", () => {
  it("says so in its status line", async () => {
    const composer = await mount({ draft: "", piNative: { ...initialPiNativeState(), mode: "native", isCompacting: true } });

    expect(composer.words()).toContain("Compacting context…");
    await composer.unmount();
  });
});
