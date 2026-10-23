import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createElement, type ComponentProps } from "react";
import TestRenderer, { act } from "react-test-renderer";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PiForkNoteRow, Turn } from "./ChatView.tsx";

const browserGlobals = ["window", "document", "HTMLElement", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame", "cancelAnimationFrame", "matchMedia", "getComputedStyle", "ResizeObserver"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");

beforeAll(() => {
  for (const name of browserGlobals) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const store = new Map<string, string>();
  const localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) };
  const media = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: (query: string) => media(query) });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class Observer { observe() {} unobserve() {} disconnect() {} } });
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

const turn = (over: Partial<ConversationTurn> = {}): ConversationTurn => ({
  role: "user", ts: null, parts: [{ kind: "text", text: "Add a retry to fetchData" }], ...over,
});

type TurnProps = ComponentProps<typeof Turn>;

/** One user turn as the transcript draws it, over the props a fork cares about. */
async function mountTurn(over: Partial<TurnProps> = {}) {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(SettingsProvider, {
      children: createElement(Turn, { paneId: "p1", turn: turn({ entry_id: "abc123" }), live: false, waiting: false, showThinking: false, expandRows: false, ...over }),
    }));
  });
  const root = renderer!.root;
  return {
    fork: () => root.findAll((node) => node.type === "button" && node.props.className === "icon-button chat-copy chat-fork"),
    rewind: () => root.findAll((node) => node.type === "button" && node.props.className === "icon-button chat-copy chat-rewind"),
  };
}

describe("Fork from here", () => {
  it("sits on a native Pi user turn beside copy, and sends the turn's own entry id and words", async () => {
    const onFork = (entryId: string, text: string): void => { sent.push({ entryId, text }); };
    const sent: Array<{ entryId: string; text: string }> = [];
    const mounted = await mountTurn({ onFork });

    const [button] = mounted.fork();
    expect(button).toBeDefined();
    expect(button!.props["aria-label"]).toBe("Fork from here");
    expect(button!.props.disabled).toBe(false);
    // the terminal's own rewind is not offered beside it: Pi has its own
    expect(mounted.rewind()).toHaveLength(0);

    await act(async () => { button!.props.onClick(); });
    expect(sent).toEqual([{ entryId: "abc123", text: "Add a retry to fetchData" }]);
  });

  it("waits while Pi runs a turn, and stays off a pane with no native Pi or no entry id", async () => {
    // mid-turn Pi takes no fork: the button is there, disabled, so the reader sees where it is
    expect((await mountTurn({ onFork: () => {}, forkBlocked: true })).fork()[0]!.props.disabled).toBe(true);
    // a Terminal-mode pane keeps today's turn: no fork at all
    expect((await mountTurn({ onFork: null })).fork()).toHaveLength(0);
    // an entry Pi gave no id for cannot be named by `fork`
    expect((await mountTurn({ onFork: () => {}, turn: turn() })).fork()).toHaveLength(0);
  });
});

describe("the row a fork leaves", () => {
  const row = async (note: { from: string; sessionFile: string | null }, onBack: (() => void) | null) => {
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      renderer = TestRenderer.create(createElement(SettingsProvider, { children: createElement(PiForkNoteRow, { note, onBack }) }));
    });
    return renderer!.root;
  };

  it("names the message it began at, with Go back to the file Pi held before it", async () => {
    const back: string[] = [];
    const root = await row({ from: "Add a retry", sessionFile: "/tmp/before.jsonl" }, () => { back.push("back"); });

    expect(root.findByProps({ className: "chat-note chat-fork-note" }).props.role).toBe("status");
    expect(root.findAllByType("span")[0]!.props.children).toBe('Forked from "Add a retry"');
    const [button] = root.findAll((node) => node.type === "button");
    expect(button!.props.children).toBe("Go back");
    await act(async () => { button!.props.onClick(); });
    expect(back).toEqual(["back"]);
  });

  it("offers no way back when Pi named no earlier file", async () => {
    const root = await row({ from: "Add a retry", sessionFile: null }, () => {});
    expect(root.findAll((node) => node.type === "button")).toHaveLength(0);
  });
});
