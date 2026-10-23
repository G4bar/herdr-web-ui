import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

import type { PiNativeState } from "../../shared/protocol.ts";
import * as actualApi from "../lib/api.ts";
import { SettingsProvider } from "../lib/settings.ts";

/** every command the page sent, and every file it wrote: the mocks answer as the server would */
const rpc: Record<string, unknown>[] = [];
const writes: Record<string, unknown>[] = [];
let file = { path: "/home/dev/.pi/agent/settings.json", settings: {} as Record<string, string | readonly string[]> };
let nativeState: PiNativeState | null = null;
let sessionValues: Record<string, unknown> = { steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true };
let refuse: string | null = null;
let saved = mock((changes: Record<string, string | readonly string[]>) => Promise.resolve({ path: file.path, settings: { ...file.settings, ...changes } }));

const { ApiError } = actualApi;
mock.module("../lib/api.ts", () => ({
  ...actualApi,
  fetchPiSettings: async () => file,
  savePiSettings: (changes: Record<string, string | readonly string[]>) => {
    writes.push(changes);
    return saved(changes);
  },
  fetchPiNativeState: async () => nativeState,
  sendPiRpc: async (_paneId: string, command: { type: string }) => {
    rpc.push(command);
    if (refuse !== null && refuse === command.type) throw new ApiError("/api/pi/rpc", 502, "Pi refused it", "command_failed");
    if (command["type"] === "get_state") return sessionValues;
    if (command["type"] === "get_available_models") return { models: [{ provider: "anthropic", id: "claude-x", name: "Claude X", reasoning: true, input: ["image"] }] };
    return {};
  },
}));
const { PiSettingsPage } = await import("./PiSettingsPage.tsx");

const browserGlobals = ["window", "document", "HTMLElement", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "getComputedStyle"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
// the page's words go through useT, which reads the browser's languages
const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });

beforeAll(() => {
  for (const name of browserGlobals) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const store = new Map<string, string>();
  const media = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  const localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: (query: string) => media(query), getSelection: () => null, addEventListener() {}, removeEventListener() {}, localStorage,
    innerWidth: 1280, innerHeight: 800, requestAnimationFrame: (run: () => void) => setTimeout(run, 0), cancelAnimationFrame: () => {},
    history: { state: null as unknown, pushState(state: unknown) { this.state = state; }, replaceState(state: unknown) { this.state = state; }, back() {} },
    location: { href: "http://localhost/" },
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
    const savedDescriptor = savedGlobals.get(name);
    if (savedDescriptor) Object.defineProperty(globalThis, name, savedDescriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

beforeEach(() => {
  rpc.length = 0;
  writes.length = 0;
  refuse = null;
  file = { path: "/home/dev/.pi/agent/settings.json", settings: { defaultProvider: "anthropic", defaultModel: "claude-x", defaultThinkingLevel: "high", enabledModels: ["claude-x"], steerOnSubmit: "queue" } };
  sessionValues = { steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true };
  nativeState = { mode: "native" } as PiNativeState;
  saved = mock((changes: Record<string, string | readonly string[]>) => Promise.resolve({ path: file.path, settings: { ...file.settings, ...changes } }));
});

const pane = { paneId: "pane-1", name: "pi · feature", machineId: "local" };

const mount = async (props: Record<string, unknown> = {}): Promise<TestRenderer.ReactTestRenderer> => {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(SettingsProvider, {
      children: createElement(PiSettingsPage, { pane, onOpenShortcuts: () => undefined, ...props }),
    }));
  });
  // the settings read and the pane's get_state settle after the first paint
  await act(async () => {});
  return renderer!;
};

/** Every text a reader sees, in order. */
const words = (renderer: TestRenderer.ReactTestRenderer): string[] =>
  renderer.root.findAll((node) => typeof node.type === "string").flatMap((node) => (node.children ?? []).filter((child): child is string => typeof child === "string"));

const group = (renderer: TestRenderer.ReactTestRenderer, label: string) => renderer.root.findByProps({ role: "group", "aria-label": label });
const toggle = (renderer: TestRenderer.ReactTestRenderer, label: string) => renderer.root.findAllByProps({ role: "switch" }).find((node) => node.props["aria-label"] === label)!;

describe("PiSettingsPage", () => {
  it("asks for a pane when none is selected", async () => {
    const renderer = await mount({ pane: null });
    expect(words(renderer)).toContain("Select a Pi agent to change its settings.");
    expect(rpc).toEqual([]);
  });

  it("names the pane it applies to and the file's defaults", async () => {
    const renderer = await mount();
    expect(words(renderer)).toContain("Applies to: pi · feature");
    expect(renderer.root.findByProps({ id: "pi-default-model" }).props.value).toBe("anthropic:claude-x");
    expect(renderer.root.findByProps({ id: "pi-default-thinking" }).props.value).toBe("high");
    expect(words(renderer)).toContain("1 of 1 in the cycle");
  });

  it("writes the two keys a model pick needs, keeping the file's other keys", async () => {
    const renderer = await mount();
    await act(async () => {
      renderer.root.findByProps({ id: "pi-default-model" }).props.onChange({ target: { value: "openai:gpt-5" } });
    });
    expect(writes).toEqual([{ defaultProvider: "openai", defaultModel: "gpt-5" }]);
  });

  it("sends the session rows as Pi's own commands", async () => {
    const renderer = await mount();
    await act(async () => {
      group(renderer, "Steering delivery").findAllByType("button").find((node) => (node.children as unknown[]).includes("All at once"))!.props.onClick();
    });
    await act(async () => {
      toggle(renderer, "Compact automatically").props.onClick();
    });
    expect(rpc).toContainEqual({ type: "set_steering_mode", mode: "all" });
    expect(rpc).toContainEqual({ type: "set_auto_compaction", enabled: false });
    // what Pi answered is what the row shows
    expect(group(renderer, "Steering delivery").findAllByType("button").some((node) => node.props["aria-pressed"] === true && (node.children as unknown[]).includes("All at once"))).toBe(true);
  });

  it("restores a refused row and says why under it", async () => {
    refuse = "set_follow_up_mode";
    const renderer = await mount();
    await act(async () => {
      group(renderer, "Follow-up delivery").findAllByType("button").find((node) => (node.children as unknown[]).includes("All at once"))!.props.onClick();
    });
    const alert = renderer.root.findAllByProps({ role: "alert" });
    expect(alert.map((node) => node.children.filter((child): child is string => typeof child === "string").join(""))).toEqual(["Couldn't change Follow-up delivery: Pi refused it"]);
    expect(group(renderer, "Follow-up delivery").findAllByType("button").some((node) => node.props["aria-pressed"] === true && (node.children as unknown[]).includes("One at a time"))).toBe(true);
  });

  it("leaves a refused file write where it was and says why", async () => {
    saved = mock(() => Promise.reject(new ApiError("/api/pi/settings", 400, "defaultThinkingLevel's value is not one pi accepts", "invalid_setting")));
    const renderer = await mount();
    await act(async () => {
      renderer.root.findByProps({ id: "pi-default-thinking" }).props.onChange({ target: { value: "xhigh" } });
    });
    expect(writes).toEqual([{ defaultThinkingLevel: "xhigh" }]);
    expect(words(renderer)).toContain("Couldn't change Default thinking level: defaultThinkingLevel's value is not one pi accepts");
    expect(renderer.root.findByProps({ id: "pi-default-thinking" }).props.value).toBe("high");
  });

  it("draws the session rows disabled for a pane the terminal owns", async () => {
    nativeState = null;
    const renderer = await mount();
    expect(rpc).toEqual([]);
    expect(toggle(renderer, "Compact automatically").props.disabled).toBe(true);
    expect(group(renderer, "Steering delivery").findAllByType("button").every((node) => node.props.disabled === true)).toBe(true);
    expect(words(renderer)).toContain("Change it in the terminal");
  });

  it("opens the shortcut list and the scoped models dialog from their rows", async () => {
    let shortcuts = 0;
    let scoped = 0;
    const renderer = await mount({ onOpenShortcuts: () => { shortcuts += 1; }, onEditScopedModels: () => { scoped += 1; } });
    const button = (label: string) => renderer.root.findAllByType("button").find((node) => (node.children as unknown[]).includes(label))!;
    await act(async () => { button("View").props.onClick(); });
    await act(async () => { button("Edit…").props.onClick(); });
    expect([shortcuts, scoped]).toEqual([1, 1]);
  });
});
