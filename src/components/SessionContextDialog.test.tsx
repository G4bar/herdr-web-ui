import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as reactDom from "react-dom";
import TestRenderer, { act } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";

// the dialog is a portal so a transformed page cannot clip it; the test renders it where it is
mock.module("react-dom", () => ({ ...reactDom, createPortal: (node: unknown) => node }));
const { SessionContextDialog } = await import("./SessionContextDialog.tsx");
const { piCommandText, piCommands, piResources } = await import("../lib/piResources.ts");

const browserGlobals = ["window", "document", "HTMLElement", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "getComputedStyle", "fetch"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });

/** What the bridge answers for this test: the pane's context chain and Pi's `get_commands`. */
let contextFiles: unknown[] = [];
let commandList: unknown[] = [];
/** every `/api/pi/rpc` command the dialog sent, in order */
const sent: unknown[] = [];

beforeAll(() => {
  for (const name of browserGlobals) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const store = new Map<string, string>();
  const media = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false, query });
  const localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: (query: string) => media(query), getSelection: () => null, localStorage,
    addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800,
    requestAnimationFrame: (run: () => void) => setTimeout(run, 0), cancelAnimationFrame: () => {},
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
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/pi/context") return Response.json({ files: contextFiles });
    if (url.pathname === "/api/pi/rpc") {
      sent.push(JSON.parse(String(init?.body)).command);
      return Response.json({ commands: commandList });
    }
    return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
  } });
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

const CONTEXT = [
  { path: "/home/me/.pi/agent/AGENTS.md", scope: "global", size: 819 },
  { path: "/work/AGENTS.md", scope: "parent", size: 1229 },
  { path: "/work/app/AGENTS.md", scope: "project", size: 410 },
];

const COMMANDS = [
  { name: "skill:review", description: "Review the diff", source: "skill", sourceInfo: { path: "/work/app/.pi/skills/review/SKILL.md", source: "local", scope: "project", origin: "top-level" } },
  { name: "fix-tests", description: "Fix failing tests", source: "prompt", sourceInfo: { path: "/work/app/.pi/prompts/fix-tests.md", source: "local", scope: "project", origin: "top-level" } },
  { name: "herdsman", description: "Steer a Herdsman agent", source: "extension", sourceInfo: { path: "/home/me/.pi/agent/extensions/herdsman.ts", source: "local", scope: "user", origin: "top-level" } },
  { name: "hm-status", description: "List agents", source: "extension", sourceInfo: { path: "/home/me/.pi/agent/extensions/herdsman.ts", source: "local", scope: "user", origin: "top-level" } },
  // built-in TUI commands are not in `get_commands`: a row of another kind is left out, never drawn
  { name: "model", description: "Select model", source: "builtin" },
];

const mount = async (props: Record<string, unknown> = {}, fixtures: { context?: unknown[]; commands?: unknown[] } = {}) => {
  contextFiles = fixtures.context ?? CONTEXT;
  commandList = fixtures.commands ?? COMMANDS;
  sent.length = 0;
  const used: string[] = [];
  let closed = 0;
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(SettingsProvider, {
      children: createElement(SessionContextDialog, {
        paneId: "p1", machineId: "local", native: true, onClose: () => { closed += 1; },
        onViewFile: () => undefined, onUse: (text: string) => used.push(text), ...props,
      }),
    }));
  });
  await act(async () => {});
  return { renderer: renderer!, used, closed: () => closed };
};

const text = (renderer: TestRenderer.ReactTestRenderer): string =>
  renderer.root.findAll((node) => typeof node.type === "string")
    .flatMap((node) => (node.children ?? []).filter((child): child is string => typeof child === "string"))
    .join("");

/** Waits for a condition instead of sleeping a set time, bounded so a broken one fails instead of hanging. */
const until = async (done: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 4_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(what);
    await Bun.sleep(10);
    await act(async () => {});
  }
};

const tab = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.findByProps({ "data-ctx-tab": id });
const click = async (node: TestRenderer.ReactTestInstance): Promise<void> => { await act(async () => { (node.props as { onClick: () => void }).onClick(); }); await act(async () => {}); };
/** The button whose words hold `label` (a busy Reload carries an icon beside its word). */
const button = (renderer: TestRenderer.ReactTestRenderer, label: string): TestRenderer.ReactTestInstance =>
  renderer.root.findAll((node) => node.type === "button" && (node.children ?? []).filter((child): child is string => typeof child === "string").join("").includes(label))[0]!;

describe("Session context", () => {
  it("names a command the way Pi runs it, and gathers an extension's commands", () => {
    expect(piCommandText({ name: "skill:review", description: "", source: "skill", scope: "project", path: null })).toBe("/skill:review ");
    expect(piCommandText({ name: "fix-tests", description: "", source: "prompt", scope: "project", path: null })).toBe("/fix-tests ");
    const { skills, prompts, extensions } = piResources(piCommands({ commands: COMMANDS }));
    expect(skills.map((command) => command.name)).toEqual(["skill:review"]);
    expect(prompts.map((command) => command.name)).toEqual(["fix-tests"]);
    expect(extensions).toEqual([{ name: "herdsman", scope: "user", commands: ["herdsman", "hm-status"] }]);
  });

  it("lists the tabs from the context route and get_commands, and offers no MCP tab", async () => {
    const { renderer } = await mount();
    await until(() => text(renderer).includes("/work/app/AGENTS.md"), "the context chain was never read");

    expect(["files", "skills", "prompts", "extensions"].map((id) => (tab(renderer, id).props.children[0].props.children as string[]).join(""))).toEqual([
      "Context files (3)", "Skills (1)", "Prompts (1)", "Extensions (1)",
    ]);
    expect(renderer.root.findAll((node) => node.props.role === "tab")).toHaveLength(4);
    // the scope of each file is Pi's own word, beside its size and the way in
    expect(text(renderer)).toContain("global");
    expect(text(renderer)).toContain("819 B");
    expect(text(renderer)).toContain("parent");
    expect(renderer.root.findAll((node) => node.type === "button" && node.props.children === "View")).toHaveLength(3);
  });

  it("puts a skill's and a prompt's command in the message box and closes", async () => {
    const { renderer, used, closed } = await mount();
    await until(() => text(renderer).includes("Context files (3)"), "the reads never answered");

    await click(tab(renderer, "skills"));
    await click(button(renderer, "Use"));
    expect(used).toEqual(["/skill:review "]);
    expect(closed()).toBe(1);

    await click(tab(renderer, "prompts"));
    await click(button(renderer, "Use"));
    expect(used).toEqual(["/skill:review ", "/fix-tests "]);
  });

  it("shows an extension's commands as pills and offers no action of its own", async () => {
    const { renderer } = await mount();
    await until(() => text(renderer).includes("Extensions (1)"), "the reads never answered");
    await click(tab(renderer, "extensions"));

    const row = renderer.root.findByProps({ className: "ctx-row ctx-extension" });
    expect(text(renderer)).toContain("/herdsman");
    expect(text(renderer)).toContain("/hm-status");
    expect(row.findAll((node) => node.type === "button")).toHaveLength(0);
  });

  it("reads the context files alone for a Terminal-mode pane, and offers no Reload", async () => {
    const { renderer } = await mount({ native: false });
    await until(() => text(renderer).includes("/work/app/AGENTS.md"), "the context chain was never read");

    expect(renderer.root.findAll((node) => node.props.role === "tab")).toHaveLength(1);
    expect((tab(renderer, "files").props.children[0].props.children as string[]).join("")).toBe("Context files (3)");
    expect(renderer.root.findAll((node) => node.type === "button" && node.props.children === "Reload")).toHaveLength(0);
    // no RPC means no `get_commands`: nothing was sent for a pane the chat does not drive
    expect(sent).toEqual([]);
  });

  it("says what is missing in each tab", async () => {
    const { renderer } = await mount({}, { context: [], commands: [] });
    await until(() => text(renderer).includes("AGENTS.md not found in this folder or above."), "the empty context state never showed");

    await click(tab(renderer, "skills"));
    expect(text(renderer)).toContain("No skills installed.");
    await click(tab(renderer, "prompts"));
    expect(text(renderer)).toContain("No prompts.");
    await click(tab(renderer, "extensions"));
    expect(text(renderer)).toContain("No extensions.");
  });

  it("reloads Pi's resources and reads both sources again", async () => {
    const { renderer } = await mount();
    await until(() => text(renderer).includes("Context files (3)"), "the reads never answered");

    await click(button(renderer, "Reload"));
    await until(() => sent.some((command) => (command as { type?: string }).type === "prompt"), "no reload was sent to Pi");
    expect(sent).toContainEqual({ type: "prompt", message: "/reload" });
    // the second read answers what Pi holds now
    contextFiles = [CONTEXT[0]!];
    await click(button(renderer, "Reload"));
    await until(() => text(renderer).includes("Context files (1)"), "the lists were not read again");
  });
});
