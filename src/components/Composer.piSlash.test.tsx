import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as reactDom from "react-dom";
import TestRenderer, { act } from "react-test-renderer";

import { initialPiNativeState } from "../../server/pi-rpc.ts";
import type { PiNativeState } from "../../shared/protocol.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { PiRpcCommand } from "../lib/api.ts";

mock.module("react-dom", () => ({ ...reactDom, createPortal: (node: unknown) => node }));
// the pane's catalog: a skill named like one of Pi's own commands, so the menu has a row to pick
const CATALOG = [{ name: "new", description: "", source: "skill" }];
mock.module("../lib/paneCommandCache.ts", () => ({ cachedPaneCommands: async () => CATALOG, onPaneCommandsInvalidated: () => () => {}, invalidatePaneCommands: () => {} }));
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

/** A native Pi's composer over a draft, with every RPC command, prompt and Settings opening recorded. */
async function mount(options: { draft: string; piNative?: PiNativeState; answer?: unknown; terminal?: boolean; agent?: string }) {
  const id = `slash${++drafts}`;
  composerDrafts.set(`ovis:composer-draft:${id}`, options.draft);
  window.localStorage.setItem("ovis:settings", JSON.stringify({ enterSends: true }));
  const commands: PiRpcCommand[] = [];
  const sent: string[] = [];
  let settingsOpened = 0;
  const terminalOpened: string[] = [];
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(SettingsProvider, {
      children: createElement(Composer, {
        connected: true, paneId: id, agent: options.agent ?? "pi", agentStatus: "idle",
        piNative: options.piNative ?? native(),
        piRpc: (command: PiRpcCommand) => { commands.push(command); return Promise.resolve(options.answer ?? null); },
        onSend: (text: string) => { sent.push(text); return true; },
        onAbort: () => {},
        onOpenSettings: () => { settingsOpened += 1; },
        onOpenTerminal: options.terminal === false ? undefined : (command: string) => { terminalOpened.push(command); },
        onUploadImage: async () => "",
      }),
    }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const root = renderer!.root;
  return {
    draft: () => root.findByProps({ className: "composer-text" }).props.value as string,
    type: async (value: string) => {
      await act(async () => { root.findByProps({ className: "composer-text" }).props.onChange({ target: { value, selectionStart: value.length } }); });
    },
    press: async (key: string) => {
      const event = { key, altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, preventDefault() {}, nativeEvent: { isComposing: false, keyCode: 13, key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false } };
      await act(async () => { root.findByProps({ className: "composer-text" }).props.onKeyDown(event); });
    },
    notes: () => root.findAllByProps({ className: "composer-note-text" }).map((node) => node.props.children).flat().filter((child): child is string => typeof child === "string").join(" "),
    commands,
    sent,
    settingsOpened: () => settingsOpened,
    terminalOpened,
    unmount: async () => { await act(async () => { renderer!.unmount(); }); },
  };
}

describe("Pi's slash commands in the message box", () => {
  it("leaves `/reload` to Pi's own message: a built-in TUI command never runs through `prompt`", async () => {
    const composer = await mount({ draft: "/reload" });

    await composer.press("Enter");
    expect(composer.sent).toEqual(["/reload"]);
    expect(composer.commands).toEqual([]);
    await composer.unmount();
  });

  it("names the session from `/name`, and compacts with its instructions", async () => {
    const named = await mount({ draft: "/name feature branch" });
    await named.press("Enter");
    expect(named.commands).toEqual([{ type: "set_session_name", name: "feature branch" }]);
    expect(named.sent).toEqual([]);
    await named.unmount();

    const compact = await mount({ draft: "/compact keep the migration" });
    await compact.press("Enter");
    expect(compact.commands).toEqual([{ type: "compact", customInstructions: "keep the migration" }]);
    expect(compact.sent).toEqual([]);
    await compact.unmount();
  });

  it("opens the model picker from `/model` and the stats from `/session`", async () => {
    const model = await mount({ draft: "/model" });
    await model.press("Enter");
    expect(model.sent).toEqual([]);
    expect(model.commands.map((command) => command.type)).toContain("get_available_models");
    await model.unmount();

    const session = await mount({ draft: "/session" });
    await session.press("Enter");
    expect(session.sent).toEqual([]);
    expect(session.commands.map((command) => command.type)).toContain("get_session_stats");
    await session.unmount();
  });

  it("opens Settings from `/hotkeys`", async () => {
    const composer = await mount({ draft: "/hotkeys" });

    await composer.press("Enter");
    expect(composer.settingsOpened()).toBe(1);
    expect(composer.sent).toEqual([]);
    await composer.unmount();
  });

  it("hands `/login` to the terminal, and says where to run it where the pane has none", async () => {
    const login = await mount({ draft: "/login" });
    await login.press("Enter");
    expect(login.terminalOpened).toEqual(["/login"]);
    expect(login.sent).toEqual([]);
    expect(login.commands).toEqual([]);
    expect(login.draft()).toBe("");
    await login.unmount();

    // no Terminal lens to hand it to: Pi's own TUI is the only place the command runs, and a
    // prompt would make it a message to the model instead
    const noTerminal = await mount({ draft: "/logout", terminal: false });
    await noTerminal.press("Enter");
    expect(noTerminal.notes()).toContain("Run /logout in the Terminal");
    expect(noTerminal.commands).toEqual([]);
    expect(noTerminal.sent).toEqual([]);
    await noTerminal.unmount();
  });

  it("completes a command named mid-sentence instead of running its surface", async () => {
    // Pi lists no command past a word, so the row comes from a pane whose catalog does (a skill
    // that happens to share a Pi command's name)
    const composer = await mount({ draft: "see ", agent: "claude" });
    await composer.type("see /new");
    await composer.press("Enter");

    expect(composer.draft()).toBe("see /new ");
    expect(composer.commands).toEqual([]);
    expect(composer.sent).toEqual([]);
    await composer.unmount();
  });

  it("leaves prose that merely names a command, and a command a later phase owns, to the message", async () => {
    const prose = await mount({ draft: "explain /model to me" });
    await prose.press("Enter");
    expect(prose.sent).toEqual(["explain /model to me"]);
    expect(prose.commands).toEqual([]);
    await prose.unmount();

    const later = await mount({ draft: "/tree" });
    await later.press("Enter");
    expect(later.sent).toEqual(["/tree"]);
    await later.unmount();
  });
});
