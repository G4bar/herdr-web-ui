/**
 * The resume list where a Pi pane the chat drives over RPC (lib/piNative.ts) is what it resumes
 * into: Open switches that pane's child to the row's session file, Rename is offered for the
 * current session alone, and Delete takes two steps and calls the bridge's own route. A pane the
 * chat does not drive keeps today's Resume (a new tab).
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as reactDom from "react-dom";
import TestRenderer, { act } from "react-test-renderer";

import type { PiNativeState, SessionHistoryRow, WorkspaceInfo } from "../../shared/protocol.ts";
import type { PiRpcCommand } from "../lib/api.ts";

// the dialog is a portal so a transformed page cannot clip it; the test renders it where it is
mock.module("react-dom", () => ({ ...reactDom, createPortal: (node: unknown) => node }));
const { SessionHistory } = await import("./SessionHistory.tsx");
const { MachineContext } = await import("../lib/machineContext.tsx");
const { piNativeLanes } = await import("../lib/piNative.ts");
const { SettingsProvider } = await import("../lib/settings.ts");

const browserGlobals = ["window", "document", "HTMLElement", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "getComputedStyle", "fetch"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });

/** every request the client made, in order */
const requests: { method: string; path: string; body: unknown }[] = [];
/** the session file the list is the current session of, and `set_session_name`'s answer */
let rows: SessionHistoryRow[] = [];

const SESSIONS: SessionHistoryRow[] = [
  { id: "s-new", title: "Retry budget", firstMessage: "Cap the retries at three.", startedAt: null, updatedAt: "2026-09-25T09:09:00.000Z", path: "/home/me/.pi/agent/sessions/--work--/s-new.jsonl", resume: { argv: ["pi", "--session", "s-new"] } },
  { id: "s-old", title: "Flaky export", firstMessage: "Why does export fail one run in ten?", startedAt: null, updatedAt: "2026-09-25T09:03:00.000Z", path: "/home/me/.pi/agent/sessions/--work--/s-old.jsonl", resume: { argv: ["pi", "--session", "s-old"] } },
];

const piState = (overrides: Partial<PiNativeState> = {}): PiNativeState => ({
  mode: "native", model: null, thinkingLevel: "high", isStreaming: false, isCompacting: false,
  steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", queue: { steering: [], followUp: [] },
  stats: null, retry: null, uiRequest: null, statuses: {}, herdsman: null, widgets: {}, notices: [], editorText: null,
  toolTails: {}, sessionFile: SESSIONS[0]!.path, sessionName: "Retry budget", ...overrides,
});

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
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
    if (url.pathname === "/api/sessions/history" && method === "GET") {
      return Response.json({ workspace_id: "w1", agent: "pi", cwd: "/work", sessions: rows }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/sessions/history" && method === "DELETE") return Response.json({ deleted: (JSON.parse(String(init?.body)) as { path: string }).path });
    if (url.pathname === "/api/agents") return Response.json({ agents: [{ kind: "pi", label: "Pi", installed: true }, { kind: "omp", label: "omp", installed: true }] });
    if (url.pathname === "/api/tab/create") return Response.json({ workspace_id: "w1", pane_id: "p9", agent_started: true });
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

const WORKSPACE = { workspace_id: "w1", label: "work" } as unknown as WorkspaceInfo;

/** Mounts the list over a fictional roster: the pane `p1` is the one it resumes into. */
const mount = async (props: Record<string, unknown> = {}) => {
  requests.length = 0;
  rows = SESSIONS;
  const rpc: PiRpcCommand[] = [];
  let closed = 0;
  let resumed = 0;
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(MachineContext.Provider, { value: "local" },
      createElement(SettingsProvider, { children: createElement(SessionHistory, {
        workspace: WORKSPACE, panes: [], agent: "pi", onClose: () => { closed += 1; }, onSelectPane: () => {},
        onResumed: () => { resumed += 1; },
        nativePaneId: "p1",
        onPiRpc: async (command: PiRpcCommand) => { rpc.push(command); return null; },
        ...props,
      }) })));
  });
  await act(async () => {});
  return { renderer: renderer!, rpc, closed: () => closed, resumed: () => resumed };
};

const text = (renderer: TestRenderer.ReactTestRenderer): string =>
  renderer.root.findAll((node) => typeof node.type === "string")
    .flatMap((node) => (node.children ?? []).filter((child): child is string => typeof child === "string"))
    .join(" ");

/** Waits for a condition instead of sleeping a set time, bounded so a broken one fails instead of hanging. */
const until = async (done: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 4_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(what);
    await Bun.sleep(10);
    await act(async () => {});
  }
};

const buttons = (renderer: TestRenderer.ReactTestRenderer, label: string): TestRenderer.ReactTestInstance[] =>
  renderer.root.findAll((node) => node.type === "button" && (node.children ?? []).filter((child): child is string => typeof child === "string").join("").trim() === label);
const button = (renderer: TestRenderer.ReactTestRenderer, label: string): TestRenderer.ReactTestInstance => buttons(renderer, label)[0]!;
const click = async (node: TestRenderer.ReactTestInstance): Promise<void> => { await act(async () => { (node.props as { onClick: () => void }).onClick(); }); await act(async () => {}); };
/** The dialog's agent field: its `onChange` is what picking another agent does. */
const pickAgent = async (renderer: TestRenderer.ReactTestRenderer, kind: string): Promise<void> => {
  const field = renderer.root.findAll((node) => Array.isArray((node.props as { agents?: unknown }).agents) && typeof (node.props as { onChange?: unknown }).onChange === "function")[0]!;
  await act(async () => { (field.props as { onChange: (kind: string) => void }).onChange(kind); });
  await act(async () => {});
};
/** The row a control sits in. */
const rowOf = (node: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance => {
  let current: TestRenderer.ReactTestInstance | null = node;
  while (current !== null && current.type !== "li") current = current.parent;
  return current!;
};
/** The dialog's own key handler, as a key pressed inside it. */
const press = async (renderer: TestRenderer.ReactTestRenderer, key: string): Promise<{ prevented: boolean }> => {
  const dialog = renderer.root.findByProps({ role: "dialog" });
  const seen = { prevented: false };
  await act(async () => {
    (dialog.props as { onKeyDown: (event: unknown) => void }).onKeyDown({ key, ctrlKey: true, altKey: false, metaKey: false, preventDefault: () => { seen.prevented = true; } });
  });
  await act(async () => {});
  return seen;
};
/** Puts the focus on a row, so the keys that act on the focused row reach it. */
const focusOnRow = (path: string | undefined): { restore: () => void } => {
  const document_ = (globalThis as unknown as { document: { activeElement: unknown } }).document;
  const saved = document_.activeElement;
  const element = new (globalThis as unknown as { HTMLElement: new () => Record<string, unknown> }).HTMLElement();
  element["closest"] = () => (path === undefined ? null : { dataset: { path } });
  document_.activeElement = element;
  return { restore: () => { document_.activeElement = saved; } };
};

describe("Earlier sessions of a native Pi pane", () => {
  it("resumes by switching the pane's child, not by starting a second agent", async () => {
    piNativeLanes.publish("p1", piState());
    const { renderer, rpc, resumed, closed } = await mount();
    await until(() => text(renderer).includes("Flaky export"), "the rows were never listed");

    // the current session is the pane's own: only the other row offers Resume
    expect(buttons(renderer, "Resume")).toHaveLength(1);
    await click(button(renderer, "Resume"));
    expect(rpc).toEqual([{ type: "switch_session", sessionPath: SESSIONS[1]!.path }]);
    expect(requests.some((request) => request.path === "/api/tab/create")).toBe(false);
    expect(resumed()).toBe(0);
    await until(() => closed() === 1, "the list stayed up after the switch");
  });

  it("offers Rename for the current session alone and sends its name", async () => {
    piNativeLanes.publish("p1", piState());
    const { renderer, rpc } = await mount();
    await until(() => text(renderer).includes("Retry budget"), "the rows were never listed");

    expect(buttons(renderer, "Rename")).toHaveLength(1);
    await click(button(renderer, "Rename"));
    const field = renderer.root.findByProps({ "aria-label": "Rename" });
    await act(async () => { (field.props as { onChange: (event: unknown) => void }).onChange({ target: { value: "Payments retry budget" } }); });
    await act(async () => { (field.props as { onKeyDown: (event: unknown) => void }).onKeyDown({ key: "Enter", preventDefault() {} }); });
    await act(async () => {});
    expect(rpc).toEqual([{ type: "set_session_name", name: "Payments retry budget" }]);
    // the store answers by listing again
    await until(() => requests.filter((request) => request.path === "/api/sessions/history" && request.method === "GET").length === 2, "the list was never read again");
  });

  it("deletes in two steps, and only through the bridge's route", async () => {
    piNativeLanes.publish("p1", piState());
    const { renderer } = await mount();
    await until(() => text(renderer).includes("Flaky export"), "the rows were never listed");

    // the current session offers no Delete of its own
    expect(buttons(renderer, "Delete")).toHaveLength(1);
    await click(button(renderer, "Delete"));
    expect(buttons(renderer, "Delete?")).toHaveLength(1);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);

    await click(button(renderer, "Delete?"));
    const deletes = requests.filter((request) => request.method === "DELETE");
    expect(deletes).toEqual([{ method: "DELETE", path: "/api/sessions/history", body: { agent: "pi", path: SESSIONS[1]!.path } }]);
  });

  it("keeps today's Resume for a pane the chat does not drive", async () => {
    const { renderer, resumed } = await mount({ nativePaneId: null, onPiRpc: undefined });
    await until(() => text(renderer).includes("Flaky export"), "the rows were never listed");

    // no Pi keys in this mode: no search, filters, Path, Delete or Rename
    expect(buttons(renderer, "Delete")).toHaveLength(0);
    expect(buttons(renderer, "Rename")).toHaveLength(0);
    await click(button(renderer, "Resume"));
    expect(requests.some((request) => request.path === "/api/tab/create")).toBe(true);
    expect(resumed()).toBe(1);
  });

  it("draws no Pi control for another agent's rows, which resume by their own argv", async () => {
    piNativeLanes.publish("p1", piState());
    const { renderer, rpc, resumed } = await mount();
    await until(() => text(renderer).includes("Flaky export"), "the rows were never listed");

    await pickAgent(renderer, "omp");
    await until(() => text(renderer).includes("Flaky export"), "the rows were never listed again");
    // the lane is Pi's: another agent's row is no switch_session, and Delete would unlink that file
    expect(buttons(renderer, "Delete")).toHaveLength(0);
    expect(buttons(renderer, "Rename")).toHaveLength(0);
    expect(renderer.root.findAll((node) => (node.props as { "aria-label"?: string })["aria-label"] === "Search sessions…")).toHaveLength(0);

    await click(button(renderer, "Resume"));
    expect(rpc).toEqual([]);
    expect(requests.some((request) => request.path === "/api/tab/create")).toBe(true);
    expect(resumed()).toBe(1);
  });

  it("recognises the current session behind a store Pi spells another way", async () => {
    // Pi reports its own spelling of the file; the row carries the store's realpath
    piNativeLanes.publish("p1", piState({ sessionFile: "/home/me/pi-link/s-new.jsonl" }));
    const { renderer } = await mount();
    await until(() => text(renderer).includes("Retry budget"), "the rows were never listed");

    // one Rename, for that row; the other row alone offers Resume and Delete
    expect(buttons(renderer, "Rename")).toHaveLength(1);
    expect(buttons(renderer, "Resume")).toHaveLength(1);
    expect(buttons(renderer, "Delete")).toHaveLength(1);
  });

  it("disarms an armed Delete when the focus leaves its row", async () => {
    piNativeLanes.publish("p1", piState());
    const { renderer } = await mount();
    await until(() => text(renderer).includes("Flaky export"), "the rows were never listed");

    await click(button(renderer, "Delete"));
    expect(buttons(renderer, "Delete?")).toHaveLength(1);
    await act(async () => { (rowOf(button(renderer, "Delete?"))!.props as { onBlur: () => void }).onBlur(); });
    expect(buttons(renderer, "Delete?")).toHaveLength(0);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("disarms an armed Delete when the search changes", async () => {
    piNativeLanes.publish("p1", piState());
    const { renderer } = await mount();
    await until(() => text(renderer).includes("Flaky export"), "the rows were never listed");

    await click(button(renderer, "Delete"));
    const search = renderer.root.findByProps({ "aria-label": "Search sessions…" });
    await act(async () => { (search.props as { onChange: (event: unknown) => void }).onChange({ target: { value: "flaky" } }); });
    await act(async () => {});
    expect(buttons(renderer, "Delete?")).toHaveLength(0);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("acts on the focused row's Delete only when that row draws one", async () => {
    piNativeLanes.publish("p1", piState());
    // a Resume of a moment ago whose pane the roster has not listed: its row says Already open
    const recent = [{ machineId: "local", workspaceId: "w1", agent: "pi" as const, id: "s-old", paneId: "p7", at: Date.now(), seen: false }];
    const withheld = await mount({ recent });
    await until(() => text(withheld.renderer).includes("Flaky export"), "the rows were never listed");
    const focused = focusOnRow(SESSIONS[1]!.path!);
    try {
      await press(withheld.renderer, "d");
      expect(buttons(withheld.renderer, "Delete?")).toHaveLength(0);
    } finally { focused.restore(); }

    // the same key does arm a row that draws Delete
    const plain = await mount();
    await until(() => text(plain.renderer).includes("Flaky export"), "the rows were never listed");
    const again = focusOnRow(SESSIONS[1]!.path!);
    try {
      await press(plain.renderer, "d");
      expect(buttons(plain.renderer, "Delete?")).toHaveLength(1);
    } finally { again.restore(); }
  });

  it("takes Ctrl+R itself, so the page it is on never reloads", async () => {
    // without a lane as well: the dialog holds the focus, so the chord is its own
    const { renderer } = await mount({ nativePaneId: null, onPiRpc: undefined });
    await until(() => text(renderer).includes("Flaky export"), "the rows were never listed");
    expect((await press(renderer, "r")).prevented).toBe(true);

    piNativeLanes.publish("p1", piState());
    const native = await mount();
    await until(() => text(native.renderer).includes("Flaky export"), "the rows were never listed");
    // on a Pi pane the chord also starts the current session's rename
    expect((await press(native.renderer, "r")).prevented).toBe(true);
    expect(native.renderer.root.findAll((node) => (node.props as { "aria-label"?: string })["aria-label"] === "Rename")).toHaveLength(1);
  });
});
