import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as reactDom from "react-dom";
import TestRenderer, { act } from "react-test-renderer";

import * as actualApi from "../lib/api.ts";
import { SettingsProvider } from "../lib/settings.ts";

/** what the dialog asked Pi, in order: the read and any fork */
const calls: { type: string; entryId?: string }[] = [];
/** `get_tree`'s answer for the next read; a fresh read answers for itself */
let tree: unknown = null;
let readFails = false;
let forkText = "";

// the dialog is a portal so a transformed page cannot clip it; the test renders it where it is
mock.module("react-dom", () => ({ ...reactDom, createPortal: (node: unknown) => node }));
mock.module("../lib/api.ts", () => ({
  ...actualApi,
  sendPiRpc: async (_paneId: string, command: { type: string; entryId?: string }) => {
    calls.push(command);
    if (command.type === "get_tree") {
      if (readFails) throw new Error("the child is gone");
      return tree;
    }
    return { text: forkText };
  },
}));
const { SessionTree } = await import("./SessionTree.tsx");

/**
 * A session with one side branch: the chat sent three messages, the user went back to the second and
 * asked something else, so the entries after it (a2, u3) sit beside that path. u2 carries a label.
 */
const answer = {
  leafId: "u3",
  tree: [{
    entry: { id: "u1", parentId: null, type: "message", timestamp: "2026-10-01T10:02:00.000Z", message: { role: "user", content: [{ type: "text", text: "Add a retry to fetchData" }] } },
    children: [{
      entry: { id: "a1", parentId: "u1", type: "message", timestamp: "2026-10-01T10:02:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "I'll add exponential backoff" }] } },
      children: [
        { entry: { id: "u2", parentId: "a1", type: "message", timestamp: "2026-10-01T10:05:00.000Z", message: { role: "user", content: [{ type: "text", text: "Actually use jitter" }] } }, label: "jitter", children: [{
          entry: { id: "a2", parentId: "u2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Switched to full jitter" }] } },
          children: [{ entry: { id: "u3", parentId: "a2", type: "message", message: { role: "user", content: "make it configurable" } }, children: [] }],
        }] },
        { entry: { id: "u4", parentId: "a1", type: "message", message: { role: "user", content: [{ type: "text", text: "Try a circuit breaker instead" }] } }, children: [] },
      ],
    }],
  }],
};

/** One message under the next: Pi's own shape for a session longer than a window of rows. */
function longTree(length: number): unknown {
  let node: unknown = null;
  for (let at = length - 1; at >= 0; at -= 1) {
    node = {
      entry: { id: `e${at}`, parentId: at === 0 ? null : `e${at - 1}`, type: "message", message: { role: "user", content: `message ${at}` } },
      children: node === null ? [] : [node],
    };
  }
  return { leafId: `e${length - 1}`, tree: [node] };
}

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
    addEventListener() {}, removeEventListener() {}, activeElement: null, body: {}, querySelector: () => null, querySelectorAll: () => [],
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
  calls.length = 0;
  tree = answer;
  readFails = false;
  forkText = "";
});

let closed = 0;
let forked: string[] = [];

/** Mounts the dialog and lets the first `get_tree` land. */
const mount = async (streaming = false) => {
  closed = 0;
  forked = [];
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(SettingsProvider, {
      children: createElement(SessionTree, {
        paneId: "w:p1",
        machineId: "local",
        streaming,
        onFork: (text: string) => { forked.push(text); },
        onClose: () => { closed += 1; },
      }),
    }));
  });
  return renderer!;
};

const words = (renderer: TestRenderer.ReactTestRenderer): string[] =>
  renderer.root.findAll((node) => typeof node.type === "string").flatMap((node) => (node.children ?? []).filter((child): child is string => typeof child === "string"));
const items = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findAllByProps({ role: "treeitem" });
/** the visible rows as `id` = the tree's own order, read off the ids the tree gives them */
const rowIds = (renderer: TestRenderer.ReactTestRenderer): string[] => items(renderer).map((node) => String(node.props.id).split("-row-")[1] ?? "");
const press = async (node: { props: { onClick?: (event?: unknown) => void } }) => { await act(async () => { node.props.onClick?.({ stopPropagation() {} }); }); };
const button = (renderer: TestRenderer.ReactTestRenderer, label: string) =>
  renderer.root.findAll((node) => node.type === "button" && (node.props["aria-label"] === label || (node.children as unknown[]).includes(label)))[0]!;
const key = async (renderer: TestRenderer.ReactTestRenderer, press: Partial<Record<string, boolean | string>>) => {
  await act(async () => {
    renderer.root.findByProps({ role: "dialog" }).props.onKeyDown({
      key: String(press["key"]), ctrlKey: press["ctrlKey"] === true, altKey: press["altKey"] === true,
      shiftKey: press["shiftKey"] === true, metaKey: false, preventDefault() {}, nativeEvent: {},
    });
  });
};
const search = async (renderer: TestRenderer.ReactTestRenderer, value: string) => {
  await act(async () => { renderer.root.findByProps({ type: "search" }).props.onChange({ target: { value } }); });
};

describe("the session tree", () => {
  it("draws Pi's entries in its own order, each with its role, and marks where the conversation is", async () => {
    const renderer = await mount();
    expect(rowIds(renderer)).toEqual(["u1", "a1", "u2", "a2", "u3", "u4"]);
    const rows = items(renderer);
    // a row's level is its place in the visible tree (one column per fork, see lib/piTree.ts), and the
    // path to the leaf carries the rail
    expect(rows.map((node) => node.props["aria-level"])).toEqual([1, 1, 2, 2, 2, 2]);
    expect(rows.map((node) => String(node.props.className).includes("is-active"))).toEqual([true, true, true, true, true, false]);
    expect(words(renderer)).toContain("You");
    expect(words(renderer)).toContain("Pi");
    // the leaf says where the conversation is, and a label rides its entry as a pill
    expect(rows[4]?.findAllByProps({ className: "pi-tree-here" }).length).toBe(1);
    expect(rows[2]?.findAllByProps({ className: "pill pi-tree-label" }).length).toBe(1);
    // the newest message the user sent on the path is selected: Enter is a fork from it
    expect(rows[4]?.props["aria-selected"]).toBe(true);
  });

  it("keeps Pi's five views: the segmented control, Ctrl+D/T/U/L/A and the Ctrl+O cycle", async () => {
    const renderer = await mount();
    await press(button(renderer, "User only"));
    expect(rowIds(renderer)).toEqual(["u1", "u2", "u3", "u4"]);
    await press(button(renderer, "Labeled"));
    expect(rowIds(renderer)).toEqual(["u2"]);
    await key(renderer, { key: "d", ctrlKey: true });
    expect(rowIds(renderer)).toEqual(["u1", "a1", "u2", "a2", "u3", "u4"]);
    // Ctrl+O cycles forward, Shift+Ctrl+O backward
    await key(renderer, { key: "o", ctrlKey: true });
    expect(rowIds(renderer)).toEqual(["u1", "a1", "u2", "a2", "u3", "u4"]);
    await key(renderer, { key: "o", ctrlKey: true, shiftKey: true });
    expect(rowIds(renderer)).toEqual(["u1", "a1", "u2", "a2", "u3", "u4"]);
    await key(renderer, { key: "u", ctrlKey: true });
    expect(rowIds(renderer)).toEqual(["u1", "u2", "u3", "u4"]);
  });

  it("filters by typed words, and says so when nothing is left", async () => {
    const renderer = await mount();
    await search(renderer, "jitter");
    // the label is searchable, and so is the answer that mentions it
    expect(rowIds(renderer)).toEqual(["u2", "a2"]);
    await search(renderer, "nothing here");
    expect(words(renderer)).toContain("No entries match");
    await search(renderer, "");
    expect(rowIds(renderer).length).toBe(6);
  });

  it("forks from a message the user sent, and leaves Enter inert on any other row", async () => {
    forkText = "make it configurable";
    const renderer = await mount();
    // the leaf is the newest message the user sent, so Enter forks from it without moving
    await key(renderer, { key: "Enter" });
    expect(calls.at(-1)).toMatchObject({ type: "fork", entryId: "u3" });
    expect(forked).toEqual(["make it configurable"]);
    expect(closed).toBe(1);
  });

  it("keeps Enter inert on an assistant row, and says why", async () => {
    const renderer = await mount();
    await key(renderer, { key: "ArrowUp" });
    // one row above the leaf is a2, an assistant turn
    expect(items(renderer).find((node) => node.props["aria-selected"] === true)?.props.id).toContain("-a2");
    expect(words(renderer)).toContain("Fork from a message you sent");
    await key(renderer, { key: "Enter" });
    expect(calls.filter((call) => call.type === "fork")).toEqual([]);
    expect(closed).toBe(0);
  });

  it("refuses a fork while Pi works, and says when it will be ready", async () => {
    const renderer = await mount(true);
    expect(words(renderer)).toContain("Pi is working. Fork when it finishes.");
    await key(renderer, { key: "Enter" });
    expect(calls.filter((call) => call.type === "fork")).toEqual([]);
  });

  it("folds a branch segment with its caret and with Ctrl+←/→, counting what it hides", async () => {
    const renderer = await mount();
    // u2 starts a segment: it has one child chain and a sibling branch
    const u2 = items(renderer).find((node) => node.props.id.endsWith("-u2"))!;
    expect(u2.props["aria-expanded"]).toBe(true);
    // the caret is a pointer target, not a tab stop of its own: the tree's keys fold
    expect(u2.findByType("button").props.tabIndex).toBe(-1);
    await press(u2.findByType("button"));
    expect(rowIds(renderer)).toEqual(["u1", "a1", "u2", "u4"]);
    expect(words(renderer)).toContain("(2 more)");
    // Ctrl+→ on the selected segment unfolds it again by key
    await key(renderer, { key: "ArrowRight", ctrlKey: true });
    expect(rowIds(renderer)).toContain("a2");
    // Ctrl+← folds it again, and a second one walks up to its parent row
    await key(renderer, { key: "ArrowLeft", ctrlKey: true });
    expect(rowIds(renderer).length).toBe(4);
    await key(renderer, { key: "ArrowLeft", ctrlKey: true });
    expect(items(renderer).find((node) => node.props["aria-selected"] === true)?.props.id).toContain("-a1");
  });

  it("shows each recorded time only when Shift+T asks for it", async () => {
    const renderer = await mount();
    expect(renderer.root.findAllByProps({ className: "pi-tree-time" })).toEqual([]);
    await key(renderer, { key: "T", shiftKey: true });
    // the fixture records a timestamp on u1, a1, u2 and u3; a row without one draws none
    expect(renderer.root.findAllByProps({ className: "pi-tree-time" }).length).toBe(3);
  });

  it("draws a window of a long tree, and widens it with Show more", async () => {
    tree = longTree(300);
    const renderer = await mount();
    // the window holds the selected row and says how many rows are left above it
    expect(items(renderer)).toHaveLength(200);
    expect(rowIds(renderer)[0]).toBe("e100");
    await press(button(renderer, "Show 100 more"));
    expect(items(renderer)).toHaveLength(300);
    expect(rowIds(renderer)[0]).toBe("e0");
  });

  it("says a session has nothing to branch from yet, and reads again after a refusal", async () => {
    tree = { tree: [], leafId: null };
    const empty = await mount();
    expect(words(empty)).toContain("Nothing to branch from yet.");

    readFails = true;
    const failed = await mount();
    expect(words(failed)).toContain("Couldn't read the session tree");
    // Try again reads a child that answers this time
    readFails = false;
    tree = answer;
    await press(button(failed, "Try again"));
    expect(rowIds(failed).length).toBe(6);
  });
});
