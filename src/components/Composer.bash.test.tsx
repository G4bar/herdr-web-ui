import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as reactDom from "react-dom";
import TestRenderer, { act } from "react-test-renderer";

import { initialPiNativeState } from "../../server/pi-rpc.ts";
import type { PiNativeState } from "../../shared/protocol.ts";
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

const BASH_PLACEHOLDER = "Run a shell command · !! keeps output out of Pi's context";
const native = (extra: Partial<PiNativeState> = {}): PiNativeState => ({ ...initialPiNativeState(), mode: "native", ...extra });

/** A native Pi's composer over a draft, with every RPC command and every prompt it sends recorded. */
async function mount(options: { draft: string; piNative?: PiNativeState }) {
  const id = `bash${++drafts}`;
  const draftKey = `ovis:composer-draft:${id}`;
  composerDrafts.set(draftKey, options.draft);
  window.localStorage.setItem("ovis:settings", JSON.stringify({ enterSends: true }));
  const commands: PiRpcCommand[] = [];
  const sent: string[] = [];
  const aborts: number[] = [];
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  const piNative = options.piNative ?? native();
  const tree = (state: PiNativeState) => createElement(SettingsProvider, {
    children: createElement(Composer, {
      connected: true, paneId: id, agent: "pi", agentStatus: state.isStreaming ? "working" : "idle",
      piNative: state,
      // a `!` command runs until its own answer, so its promise is never settled here: the test stops it
      piRpc: (command: PiRpcCommand) => { commands.push(command); return command.type === "bash" ? new Promise(() => undefined) : Promise.resolve(null); },
      onSend: (text: string) => { sent.push(text); return true; },
      onAbort: () => { aborts.push(Date.now()); },
      onUploadImage: async () => "",
    }),
  });
  await act(async () => { renderer = TestRenderer.create(tree(piNative)); });
  // the effects a mount leaves behind (a first command read, a redraw frame) settle here, not mid-assertion
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const root = renderer!.root;
  const hasClass = (name: string) => (node: TestRenderer.ReactTestInstance) =>
    typeof node.props.className === "string" && node.props.className.split(" ").includes(name);
  return {
    words: () => root.findAll((node) => typeof node.type === "string").flatMap((node) => (node.children ?? []).filter((child): child is string => typeof child === "string")),
    chip: () => root.findAllByProps({ className: "composer-bash-chip" }).length,
    rail: () => root.findByProps({ className: "composer-surface" }).props["data-bash"] !== undefined,
    placeholder: () => root.findByProps({ className: "composer-text" }).props.placeholder as string,
    runBlock: () => root.findAll(hasClass("composer-bash-run")).length,
    tail: () => root.findAll(hasClass("chat-tool-tail")).map((node) => node.props.children),
    press: async (key: string) => {
      const event = { key, altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, preventDefault() {}, nativeEvent: { isComposing: false, keyCode: 13 } };
      await act(async () => { root.findByProps({ className: "composer-text" }).props.onKeyDown(event); });
    },
    /** the pane's live state moved on (a tail arrived): the same composer, drawn again */
    update: async (state: PiNativeState) => { await act(async () => { renderer!.update(tree(state)); }); },
    commands,
    sent,
    aborts,
    unmount: async () => { await act(async () => { renderer!.unmount(); }); },
  };
}

describe("bash mode", () => {
  it("draws the `$` chip, the rail and the bash placeholder for a `!` draft, and sends nothing", async () => {
    const composer = await mount({ draft: "! ls -la" });

    expect(composer.chip()).toBe(1);
    expect(composer.rail()).toBe(true);
    expect(composer.placeholder()).toBe(BASH_PLACEHOLDER);
    expect(composer.words()).toContain("$");
    await composer.unmount();
  });

  it("draws none of it for an ordinary draft", async () => {
    const composer = await mount({ draft: "explain the build" });

    expect(composer.chip()).toBe(0);
    expect(composer.rail()).toBe(false);
    expect(composer.placeholder()).toBe("Message Pi…");
    await composer.unmount();
  });

  it("reads whitespace before the bang as Pi's bash mode does", async () => {
    const composer = await mount({ draft: "   ! echo hi" });

    expect(composer.chip()).toBe(1);
    await composer.unmount();
  });
});

describe("running a `!` command", () => {
  it("runs it through pi's bash and not as a prompt", async () => {
    const composer = await mount({ draft: "! ls -la" });

    await composer.press("Enter");
    expect(composer.sent).toEqual([]);
    expect(composer.commands).toHaveLength(1);
    expect(composer.commands[0]).toMatchObject({ type: "bash", command: "ls -la", excludeFromContext: false });
    await composer.unmount();
  });

  it("keeps a `!!` command's output out of Pi's context", async () => {
    const composer = await mount({ draft: "!! bun test" });

    await composer.press("Enter");
    expect(composer.commands[0]).toMatchObject({ type: "bash", command: "bun test", excludeFromContext: true });
    await composer.unmount();
  });

  it("draws its last lines under a Stop, and cancels it on Escape", async () => {
    const composer = await mount({ draft: "! ls" });

    await composer.press("Enter");
    expect(composer.runBlock()).toBe(1);
    const id = String(composer.commands[0]?.id);
    await composer.update(native({ toolTails: { [id]: ["one", "two"] } }));
    expect(composer.tail()).toEqual(["one\ntwo"]);

    await composer.press("Escape");
    expect(composer.commands.at(-1)).toEqual({ type: "abort_bash" });
    // the run behind the command is untouched: Escape cancels the shell command first
    expect(composer.aborts).toEqual([]);
    await composer.unmount();
  });
});
