import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";

import type { PiRpcCommand } from "../lib/api.ts";
import { translate } from "../lib/i18n.ts";
import type { PiQueueRow } from "../lib/piNative.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PendingMessages } from "./PendingMessages.tsx";

const render = (code: string, message: string, languages: string[], serverOwned = true): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: languages });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PendingMessages, {
      messages: [{ id: "p1", request_id: 1, text: "ls", state: "held", created_at: "2026-10-14T00:00:00.000Z", serverOwned, error: { code, message } }],
      connected: true, blocked: false, unsaved: false, isBusy: () => false,
      onSendNow: async () => {}, onDiscard: async () => {},
    }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

// the browser globals the settings provider and a click reach for; the composer's own test stubs the same
const browserGlobals = ["window", "document", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
beforeAll(() => {
  for (const name of browserGlobals) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  const store = new Map<string, string>();
  const localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, localStorage,
    // Clear queue's two-step timer never runs here: what it asks is read in the same pass
    setTimeout: () => 0,
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    addEventListener() {}, removeEventListener() {}, activeElement: null, body: {},
    querySelector: () => null, getElementById: () => null, getSelection: () => null,
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, lang: "", colorScheme: "" },
  } });
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

/** One provider per test: a mount left behind would draw over the next test's */
const mounted: TestRenderer.ReactTestRenderer[] = [];
afterEach(async () => { await act(async () => { for (const renderer of mounted.splice(0)) renderer.unmount(); }); });

const STEER: PiQueueRow = { kind: "steer", text: "stop the migration" };
const FOLLOW: PiQueueRow = { kind: "followUp", text: "then run the tests" };

/** A native pane's Held list over Pi's queue: every command it sends is recorded, and so is what goes to the box. */
async function mountQueue(queue: PiQueueRow[], answer: { steering: string[]; followUp: string[] } = { steering: [STEER.text], followUp: [FOLLOW.text] }) {
  const calls: PiRpcCommand[] = [];
  const drew: string[] = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  const element = createElement(SettingsProvider, { children: createElement(PendingMessages, {
    messages: [], connected: true, blocked: false, unsaved: false, isBusy: () => false,
    onSendNow: async () => {}, onDiscard: async () => {},
    queue, streaming: true,
    piRpc: async (command) => { calls.push(command); return command.type === "clear_queue" ? answer : null; },
    onRestoreText: (texts) => { drew.push(...texts); },
  }) });
  await act(async () => { renderer = TestRenderer.create(element); });
  mounted.push(renderer);
  const root = renderer.root;
  const byText = (label: string) => root.findAllByType("button").find((button) => ([] as unknown[]).concat(button.props.children).some((child) => child === label));
  const click = async (button: TestRenderer.ReactTestInstance) => { await act(async () => { button.props.onClick({ detail: 1 }); }); };
  return {
    calls, drew, root, click, byText,
    rowButtons: (label: string) => root.findAllByType("button").filter((button) => button.props["aria-label"] === label),
    head: () => root.findAll((node) => node.props.className === "pending-queue-head").length,
    kinds: () => root.findAll((node) => typeof node.props.className === "string" && node.props.className.startsWith("pill pending-queue-kind"))
      .map((node) => node.props.children),
  };
}

describe("a pending row's refusal note", () => {
  it("says a held-input refusal in the reader's language, not the raw English reason", () => {
    const held = translate("ko", "Not sent: send or discard the held input first.");
    expect(held).not.toBe("Not sent: send or discard the held input first.");
    const html = render("held_input", "send or discard the held input first", ["ko"]);
    expect(html).toContain(held);
    expect(html).not.toContain("send or discard the held input first");
  });

  it("keeps Send now on a saved copy whose send never left the browser, and says it was not sent (regression #541)", () => {
    const note = translate("ko", "Not sent: the connection dropped before this message left. Send it again.");
    expect(note).not.toBe("Not sent: the connection dropped before this message left. Send it again.");
    const html = render("not_transmitted", "the connection dropped before this message was sent", ["ko"], false);
    expect(html).toContain(note);
    expect(html).toContain("pending-message-send");
    expect(html).not.toContain("the connection dropped before this message was sent");
  });

  it("shows the still-open note as the composer wrote it, once", () => {
    const note = translate("ko", "Not sent: {command} is still open in the terminal.", { command: "/btw" });
    const html = render("still_open", note, ["ko"]);
    expect(html).toContain(note);
    expect(html).not.toContain(translate("ko", "Not sent: {message}", { message: note }));
  });

  it("keeps the server's reason for other refusals", () => {
    expect(render("agent_blocked", "the agent is busy", ["en"])).toContain("Not sent: the agent is busy");
  });
});

describe("a native pane's Held list", () => {
  it("draws Pi's queue in delivery order, each row with its kind, under the queue's own head", async () => {
    const held = await mountQueue([STEER, FOLLOW]);
    expect(held.head()).toBe(1);
    expect(held.kinds()).toEqual(["Steer", "Follow-up"]);
    expect(held.byText("Restore all")).toBeDefined();
    expect(held.byText("Clear queue")).toBeDefined();
    // a pane whose queue Pi does not hold keeps the rows it always drew, with no head over them
    const plain = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PendingMessages, {
      messages: [{ id: "p1", request_id: 1, text: "ls", state: "held", created_at: "2026-10-14T00:00:00.000Z", serverOwned: true }],
      connected: true, blocked: false, unsaved: false, isBusy: () => false,
      onSendNow: async () => {}, onDiscard: async () => {},
    }) }));
    expect(plain).not.toContain("pending-queue-head");
    expect(plain).not.toContain("pending-queue-kind");
  });

  it("asks twice before Clear queue, then takes the queue out and puts nothing back", async () => {
    const held = await mountQueue([STEER, FOLLOW]);
    await held.click(held.byText("Clear queue")!);
    expect(held.byText("Clear queue?")).toBeDefined();
    expect(held.calls).toEqual([]);
    await held.click(held.byText("Clear queue?")!);
    expect(held.calls.map((command) => command.type)).toEqual(["clear_queue"]);
    expect(held.drew).toEqual([]);
  });

  it("Restore takes one row out, puts the others back in order, and its text into the box", async () => {
    const held = await mountQueue([STEER, FOLLOW]);
    await held.click(held.rowButtons("Restore to message box")[0]!);
    expect(held.calls).toEqual([
      { type: "clear_queue" },
      { type: "prompt", message: FOLLOW.text, streamingBehavior: "followUp" },
    ]);
    expect(held.drew).toEqual([STEER.text]);
  });

  it("Remove puts the kept rows back as the kinds they were sent as", async () => {
    const held = await mountQueue([STEER, FOLLOW]);
    await held.click(held.rowButtons("Remove")[1]!);
    expect(held.calls).toEqual([
      { type: "clear_queue" },
      { type: "prompt", message: STEER.text, streamingBehavior: "steer" },
    ]);
    expect(held.drew).toEqual([]);
  });

  it("Restore all moves the whole queue into the message box", async () => {
    const held = await mountQueue([STEER, FOLLOW]);
    await held.click(held.byText("Restore all")!);
    expect(held.calls.map((command) => command.type)).toEqual(["clear_queue"]);
    expect(held.drew).toEqual([STEER.text, FOLLOW.text]);
  });
});
