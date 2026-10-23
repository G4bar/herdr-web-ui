import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as reactDom from "react-dom";
import TestRenderer, { act } from "react-test-renderer";

import type { HerdsmanAgent } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";

// the close confirmation is a portal so a transformed page cannot clip it; the test renders it where it is
mock.module("react-dom", () => ({ ...reactDom, createPortal: (node: unknown) => node }));
const { AgentPanel } = await import("./AgentPanel.tsx");

const browserGlobals = ["window", "document", "HTMLElement", "localStorage", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
// the panel's words go through useT, which reads the browser's languages
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
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    history: { state: null as unknown, pushState(state: unknown) { this.state = state; }, replaceState(state: unknown) { this.state = state; }, back() {} },
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    activeElement: null, body: {}, querySelector: () => null, getElementById: () => null, getSelection: () => null,
    addEventListener() {}, removeEventListener() {},
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, lang: "", colorScheme: "" },
  } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class Element {} });
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

/** the scout of the roster's fixture, running unless a test says otherwise */
const agentOf = (fields: Partial<HerdsmanAgent> = {}): HerdsmanAgent => ({
  label: "scout_ui", definition: "scout", parent: "lead", state: "running", startedAt: 0, task: "Map the chat UI", ...fields,
});

const ALL_CAPABILITIES = ["steer", "interrupt", "reply", "close", "continue"];

/** every string drawn inside `node`, in order */
const strings = (node: TestRenderer.ReactTestInstance): string[] =>
  node.children.flatMap((child) => (typeof child === "string" || typeof child === "number" ? [String(child)] : strings(child)));
/** what `node` reads: a glyph button is named by its `aria-label`, a labelled one by its text */
const text = (node: TestRenderer.ReactTestInstance): string => strings(node).join("").trim();

const mount = async (agent: HerdsmanAgent, capabilities: readonly string[] = ALL_CAPABILITIES) => {
  const commands: string[] = [];
  let closed = 0;
  let expanded = 0;
  const render = (next: HerdsmanAgent) => createElement(SettingsProvider, {
    children: createElement(AgentPanel, {
      agent: next,
      capabilities,
      onCommand: (command: string) => { commands.push(command); },
      onClose: () => { closed += 1; },
      onExpand: () => { expanded += 1; },
    }),
  });
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => { renderer = TestRenderer.create(render(agent)); });
  return {
    renderer: renderer!,
    commands,
    closed: () => closed,
    expanded: () => expanded,
    update: async (next: HerdsmanAgent) => { await act(async () => { renderer!.update(render(next)); }); },
  };
};

const named = (label: string) => (node: TestRenderer.ReactTestInstance): boolean =>
  node.type === "button" && (text(node) === label || node.props["aria-label"] === label);
const buttons = (renderer: TestRenderer.ReactTestRenderer, label: string): TestRenderer.ReactTestInstance[] => renderer.root.findAll(named(label));
const button = (renderer: TestRenderer.ReactTestRenderer, label: string): TestRenderer.ReactTestInstance => {
  const found = buttons(renderer, label);
  if (found.length === 0) throw new Error(`no button reads "${label}"`);
  return found[0]!;
};
const has = (renderer: TestRenderer.ReactTestRenderer, label: string): boolean => buttons(renderer, label).length > 0;
const modes = (renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance =>
  renderer.root.findByProps({ className: "segmented agent-panel-modes" });
/** the header's state badge, which is a word rather than a button */
const badge = (renderer: TestRenderer.ReactTestRenderer): string =>
  text(renderer.root.findAll((node) => typeof node.type === "string" && String(node.props.className ?? "").startsWith("pill agent-panel-state"))[0]!);

const type = async (renderer: TestRenderer.ReactTestRenderer, text: string): Promise<void> => {
  const field = renderer.root.findByProps({ className: "input agent-panel-field" });
  await act(async () => { field.props.onChange({ target: { value: text } }); });
};
const press = async (renderer: TestRenderer.ReactTestRenderer, label: string): Promise<void> => {
  const target = button(renderer, label);
  await act(async () => { target.props.onClick({ detail: 1, currentTarget: target }); });
};

describe("AgentPanel", () => {
  it("disables Reply while the agent asks nothing, and Steer stays the mode", async () => {
    const { renderer } = await mount(agentOf());
    const reply = button(renderer, "Reply");
    expect(reply.props["aria-disabled"]).toBe(true);
    expect(reply.props.title).toBe("It isn't asking anything.");
    await press(renderer, "Reply");
    // the press went nowhere: Steer is still pressed and no question is drawn
    expect(button(renderer, "Steer").props["aria-pressed"]).toBe(true);
    expect(renderer.root.findAllByProps({ className: "agent-panel-question" })).toHaveLength(0);
  });

  it("sends an interrupt on the second press of the same button", async () => {
    const panel = await mount(agentOf(), ["interrupt"]);
    await type(panel.renderer, "stop the run");
    await press(panel.renderer, "Send");
    expect(panel.commands).toEqual([]);
    const armed = button(panel.renderer, "Interrupt now?");
    expect(armed.props.className).toBe("btn btn-danger");
    await act(async () => { armed.props.onClick({ detail: 1, currentTarget: armed }); });
    expect(panel.commands).toEqual(["/hm interrupt scout_ui stop the run"]);
    // the draft left with the command, and the button is a plain Send again
    expect(panel.renderer.root.findByProps({ className: "input agent-panel-field" }).props.value).toBe("");
    expect(has(panel.renderer, "Interrupt now?")).toBe(false);
  });

  it("forgets the armed interrupt when the field is edited", async () => {
    const panel = await mount(agentOf(), ["interrupt"]);
    await type(panel.renderer, "stop the run");
    await press(panel.renderer, "Send");
    await type(panel.renderer, "stop the run now");
    expect(has(panel.renderer, "Interrupt now?")).toBe(false);
    await press(panel.renderer, "Send");
    expect(panel.commands).toEqual([]);
  });

  it("sends the exact /hm command for steer, reply, close and continue", async () => {
    const steer = await mount(agentOf(), ["steer"]);
    await type(steer.renderer, "also check Composer.tsx");
    await press(steer.renderer, "Send");
    expect(steer.commands).toEqual(["/hm steer scout_ui also check Composer.tsx"]);

    // a question takes the mode on its own, and is drawn above the field with its files
    const reply = await mount(agentOf({ state: "asks", question: { text: "Which colour?", files: ["tmp/theme.css"] } }), ["reply"]);
    expect(button(reply.renderer, "Reply").props["aria-pressed"]).toBe(true);
    expect(text(reply.renderer.root.findByProps({ className: "agent-panel-question" }))).toContain("Which colour?");
    expect(text(reply.renderer.root.findByProps({ className: "agent-panel-question" }))).toContain("tmp/theme.css");
    await type(reply.renderer, "the amber one");
    await press(reply.renderer, "Send");
    expect(reply.commands).toEqual(["/hm reply scout_ui the amber one"]);

    const close = await mount(agentOf(), ["close"]);
    await press(close.renderer, "Close agent");
    // the confirmation asks first, and the deed runs from its own button
    expect(close.commands).toEqual([]);
    const confirm = close.renderer.root.findAll((node) => node.type === "button" && node.props.className === "btn btn-danger");
    expect(strings(confirm[0]!).join("")).toBe("Close agent");
    await act(async () => { await confirm[0]!.props.onClick(); });
    expect(close.commands).toEqual(["/hm close scout_ui"]);
    expect(close.closed()).toBe(1);

    const ended = await mount(agentOf({ state: "finished", answer: "Done.", resumable: true }), ["continue"]);
    await press(ended.renderer, "Continue");
    expect(ended.commands).toEqual(["/hm continue scout_ui"]);
  });

  it("draws only the modes the extension offers", async () => {
    const panel = await mount(agentOf(), ["steer"]);
    const drawn = modes(panel.renderer).findAll((node) => node.type === "button").map((node) => text(node));
    expect(drawn).toEqual(["Steer"]);
    // no close capability, no Close agent at the foot
    expect(has(panel.renderer, "Close agent")).toBe(false);

    const shut = await mount(agentOf(), []);
    expect(shut.renderer.root.findAllByProps({ className: "segmented agent-panel-modes" })).toHaveLength(0);
  });

  it("keeps the answer of a finished agent, and offers Continue only once it is resumable", async () => {
    const resumable = await mount(agentOf({ state: "finished", answer: "The migration is applied.", resumable: true }));
    expect(badge(resumable.renderer)).toBe("Finished");
    expect(text(resumable.renderer.root.findByProps({ className: "agent-panel-answer" }))).toContain("The migration is applied.");
    expect(text(resumable.renderer.root.findByProps({ className: "agent-panel-ended-note" }))).toBe("This agent has finished.");
    // the message box is gone with the run
    expect(resumable.renderer.root.findAllByProps({ className: "input agent-panel-field" })).toHaveLength(0);
    expect(has(resumable.renderer, "Continue")).toBe(true);

    const done = await mount(agentOf({ state: "finished", answer: "The migration is applied." }));
    expect(has(done.renderer, "Continue")).toBe(false);

    const failed = await mount(agentOf({ state: "failed", answer: "The build broke.", resumable: true }));
    expect(badge(failed.renderer)).toBe("Failed");
    expect(has(failed.renderer, "Continue")).toBe(true);
  });

  it("follows the activity feed at most once a second, newest last", async () => {
    const panel = await mount(agentOf({ activity: ["Read src/components/ChatView.tsx"] }));
    const lines = () => panel.renderer.root.findAllByProps({ className: "agent-panel-line" }).map((line) => text(line));
    expect(lines()).toEqual(["Read src/components/ChatView.tsx"]);

    await panel.update(agentOf({ activity: ["Read src/components/ChatView.tsx", "Ran rg ToolInputView src"] }));
    // the swap is trailing: the newest lines wait for the second to pass
    expect(lines()).toEqual(["Read src/components/ChatView.tsx"]);
    // fixed wait: the feed throttles to one swap a second, so nothing arrives before it
    await act(async () => { await new Promise((settle) => setTimeout(settle, 1_100)); });
    expect(lines()).toEqual(["Read src/components/ChatView.tsx", "Ran rg ToolInputView src"]);
  });

  it("takes the expand glyph only when the owner can widen the panel", async () => {
    const panel = await mount(agentOf());
    expect(has(panel.renderer, "Expand")).toBe(true);
    expect(has(panel.renderer, "Close panel")).toBe(true);
    await press(panel.renderer, "Close panel");
    expect(panel.closed()).toBe(1);
  });
});
