import { afterAll, beforeAll, describe, expect, it, jest } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";

import type { InteractivePrompt } from "../../shared/protocol.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PromptCard, TrustCard } from "./PromptCard.tsx";

const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });

/** A pi ask_user_question card: the screen's own fields, plus whatever the session's call added. */
const card = (fields: Partial<InteractivePrompt> = {}): InteractivePrompt => ({
  id: "p1",
  agent: "pi",
  kind: "question",
  title: "Layout",
  question: "Which layout should the settings page use?",
  body: null,
  options: [{ label: "Sidebar", description: "Vertical nav with a detail pane." }, { label: "Tabs", description: "Horizontal tabs at the top." }],
  multi_select: false,
  custom_option_index: 2,
  ...fields,
});

const render = (prompt: InteractivePrompt, typedAnswer: { option_index: number } | null = null) => renderToStaticMarkup(createElement(SettingsProvider, {
  children: createElement(PromptCard, { paneId: "pane-1", prompt, typedAnswer, onPromptChanged() {}, onAnswered() {} }),
}));

const text = (html: string) => html.replace(/<[^>]*>/g, "");

// The one stateful test below mounts the card, so SettingsProvider's effect and the answer path need
// the browser globals they read; every other test here renders to static markup and needs none.
const browserGlobals = ["window", "document", "localStorage", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  for (const name of browserGlobals) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const store = new Map<string, string>();
  const media = { matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false };
  const localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: () => media, getSelection: () => null, addEventListener() {}, removeEventListener() {}, localStorage,
    // the card's own frame and its timer: looked up per call, so a test's fake timers replace them
    requestAnimationFrame: (callback: (time: number) => void) => { callback(0); return 0; }, cancelAnimationFrame() {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args), clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args), clearInterval: (id: number) => clearInterval(id),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    addEventListener() {}, removeEventListener() {}, activeElement: null, body: {}, querySelector: () => null, getSelection: () => null,
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, lang: "", colorScheme: "" },
  } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterAll(() => {
  for (const name of browserGlobals) {
    const saved = savedGlobals.get(name);
    if (saved) Object.defineProperty(globalThis, name, saved);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe("the question card", () => {
  it("heads the card with its header, and with its title where no header came", () => {
    expect(render(card({ header: "Layout" }))).toContain("<h2>Layout</h2>");
    expect(render(card({ title: "Library" }))).toContain("<h2>Library</h2>");
  });

  it("says the question under the heading only when the heading is not the question", () => {
    // pi's heading already is the question: said once
    const once = render(card({ header: "Which layout should the settings page use?" }));
    expect(text(once).split("Which layout should the settings page use?").length - 1).toBe(1);
    expect(text(render(card({ header: "Layout" }))).split("Which layout should the settings page use?").length - 1).toBe(1);
  });

  it("tags the option the call recommends, by index, without moving or picking it", () => {
    const html = render(card({ recommended_index: 1 }));
    expect(html.split("Recommended").length - 1).toBe(1);
    expect(html.indexOf("Tabs")).toBeLessThan(html.indexOf("Recommended"));
    // not pre-selected: a row shows the tag, never the pick
    expect(html).not.toContain("is-checked");
    expect(html).not.toContain('type="radio"');
  });

  it("keeps the tag a label already spells out, once", () => {
    const options = [{ label: "Sidebar", description: null }, { label: "Tabs (Recommended)", description: null }];
    const html = render(card({ options }));
    expect(html.split("Recommended").length - 1).toBe(1);
    expect(html).toContain(">Tabs <span class=\"prompt-card-tag\">Recommended</span>");
  });

  it("picks a previewed question with radios, then submits", () => {
    const options = [{ label: "Sidebar", description: null, preview: "+---+---+\n| a | b |\n+---+---+" }, { label: "Tabs", description: null, preview: null }];
    const html = render(card({ options }));
    // no option answers on its own: each row is a radio, the one sender is Submit
    expect(html.split('type="radio"').length - 1).toBe(2);
    expect(html).not.toContain('type="checkbox"');
    expect(html.split("prompt-card-submit").length - 1).toBe(1);
    // Submit sits in the card's sticky footer, so a long card never scrolls it out of reach
    expect(html).toContain('<div class="prompt-card-actions"><button type="button" class="btn prompt-card-submit" disabled="">Submit</button></div>');
    expect(html).toContain('role="radiogroup"');
    expect(html).not.toContain("prompt-card-confirm");
    // nothing picked yet: the box gives way to the line that says what to do
    expect(html).toContain("Pick an option to see its preview.");
    expect(html).not.toContain("prompt-card-preview");
  });

  it("checks the radio a number typed in the composer picked, and previews it", () => {
    const options = [{ label: "Sidebar", description: null, preview: "+---+---+\n| a | b |\n+---+---+" }, { label: "Tabs", description: null, preview: null }];
    const html = render(card({ options }), { option_index: 0 });
    expect(html).toContain('aria-label="Preview: Sidebar"');
    expect(html).toContain("| a | b |");
    expect(html).toContain("is-checked");
    // the pick is shown on its radio and sent by Submit, not by a Confirm step
    expect(html.split('checked=""').length - 1).toBe(1);
    expect(html).toContain("btn btn-primary prompt-card-submit");
    expect(html).not.toContain("prompt-card-confirm");
  });

  it("says so in the box when the checked option has no preview", () => {
    const options = [{ label: "Sidebar", description: null, preview: "+---+---+" }, { label: "Tabs", description: null }];
    const html = render(card({ options }), { option_index: 1 });
    expect(html).toContain('aria-label="Preview: Tabs"');
    expect(html).toContain("No preview for this option.");
  });

  it("answers a question without previews as it did before", () => {
    const html = render(card());
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain("prompt-card-preview");
    expect(html).not.toContain("prompt-card-submit");
    expect(html).not.toContain("prompt-card-actions");
    // the custom row is still the only way to say something else
    expect(html).toContain("Or type your own answer");
  });

  it("submits a multiple choice with previews by the same Submit button", () => {
    const options = [{ label: "Sidebar", description: null, preview: "+---+" }, { label: "Tabs", description: null }];
    const html = render(card({ multi_select: true, options }));
    expect(html.split('type="checkbox"').length - 1).toBe(2);
    expect(html).toContain('role="group"');
    expect(html).toContain(">Submit</button></div>");
    expect(html).toContain("Pick an option to see its preview.");
  });

  // a choice made in the card has to survive a later typed answer, which a fresh render cannot show
  it("checks the radio a later typed answer picks, and submits that option", async () => {
    const bodies: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      bodies.push(String(init?.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const options = [{ label: "Sidebar", description: null, preview: "+---+" }, { label: "Tabs", description: null }];
    const element = (typedAnswer: { option_index: number } | null) => createElement(SettingsProvider, null,
      createElement(PromptCard, { paneId: "p1", prompt: card({ options }), typedAnswer, onPromptChanged() {}, onAnswered() {} }));
    const radios = (tree: TestRenderer.ReactTestRenderer) => tree.root.findAll((node) => node.type === "input");
    let tree!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => { tree = TestRenderer.create(element(null)); });
      await act(async () => { radios(tree)[0]!.props.onChange(); });
      expect(radios(tree).map((radio) => radio.props.checked)).toEqual([true, false]);
      // the number typed in the composer is picked over the click, and is what Submit sends
      await act(async () => { tree.update(element({ option_index: 1 })); });
      expect(radios(tree).map((radio) => radio.props.checked)).toEqual([false, true]);
      const submit = tree.root.findAll((node) => typeof node.type === "string" && String(node.props.className ?? "").includes("prompt-card-submit"))[0]!;
      expect(submit.props.disabled).toBe(false);
      await act(async () => { submit.props.onClick({ nativeEvent: { pointerType: "mouse", detail: 1 }, currentTarget: {} }); });
      expect(JSON.parse(bodies[0]!)).toEqual({ pane_id: "p1", prompt_id: "p1", option_index: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** Pi's own dialogs (RPC `extension_ui_request`) come through the same card: `confirm` asks two buttons, `input`/`editor` type an answer. */
const confirmation = (fields: Partial<InteractivePrompt> = {}): InteractivePrompt => card({
  variant: "confirm", kind: "approval", title: "Run the tests?", question: "Run the full test suite?",
  options: [{ label: "Deny", description: null }, { label: "Allow", description: null }],
  custom_option_index: null, ...fields,
});

const typedAnswerCard = (variant: "input" | "editor", fields: Partial<InteractivePrompt> = {}): InteractivePrompt => card({
  variant, kind: "question", title: "Branch name", question: "",
  options: [{ label: "feature/pi", description: null }], custom_option_index: 0, ...fields,
});

/** Mounts a card, its answers recorded as the fetch bodies they were sent in. */
async function mount(element: ReactElement) {
  const bodies: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    if (init?.body !== undefined) bodies.push(String(init.body));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(createElement(SettingsProvider, null, element)); });
  return { bodies, tree, restore: () => { act(() => { tree.unmount(); }); globalThis.fetch = originalFetch; } };
}

const prompt = (cardPrompt: InteractivePrompt) => createElement(PromptCard, { paneId: "p1", prompt: cardPrompt, onPromptChanged() {}, onAnswered() {} });

const byClass = (tree: TestRenderer.ReactTestRenderer, className: string) => tree.root.findAll((node) => typeof node.type === "string" && String(node.props.className ?? "").includes(className));

describe("the card of pi's own dialogs", () => {
  it("previews the row in focus, and describes the rows by that one box", async () => {
    const options = [
      { label: "Sidebar", description: null, preview: "+--+\n| a |" },
      { label: "Tabs", description: null, preview: "+--+\n| b |" },
    ];
    const mounted = await mount(prompt(card({ options })));
    try {
      const rows = mounted.tree.root.findAll((node) => node.type === "label");
      expect(rows).toHaveLength(2);
      // nothing in focus: no box yet, and the rows point at none
      expect(byClass(mounted.tree, "prompt-card-preview")).toHaveLength(0);
      expect(byClass(mounted.tree, "prompt-card-options")[0]!.props["aria-describedby"]).toBeUndefined();
      await act(async () => { rows[1]!.props.onFocus(); });
      const box = byClass(mounted.tree, "prompt-card-preview")[0]!;
      expect(box.props.children).toBe("+--+\n| b |");
      // the box is the rows' description, and it is no live region: a change is not announced
      expect(byClass(mounted.tree, "prompt-card-options")[0]!.props["aria-describedby"]).toBe(box.props.id);
      expect(box.props.role).toBe("region");
      expect(box.props["aria-live"]).toBeUndefined();
    } finally {
      mounted.restore();
    }
  });

  it("draws pi's confirmation as Deny | Allow, neither filled and neither numbered", () => {
    const html = render(confirmation());
    expect(html).toContain("prompt-card-buttons");
    expect(html).not.toContain("btn-primary");
    expect(html).not.toContain("prompt-card-number");
    const words = text(html);
    expect(words.indexOf("Deny")).toBeLessThan(words.indexOf("Allow"));
  });

  it("takes Esc on that confirmation as Deny", async () => {
    const mounted = await mount(prompt(confirmation()));
    try {
      const section = mounted.tree.root.findAll((node) => node.type === "section")[0]!;
      await act(async () => { section.props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} }); });
      expect(JSON.parse(mounted.bodies[0]!)).toEqual({ pane_id: "p1", prompt_id: "p1", option_index: 0 });
    } finally {
      mounted.restore();
    }
  });

  it("counts to pi's own denial, announcing it at the start and at 10 s only", async () => {
    jest.useFakeTimers();
    const mounted = await mount(prompt(confirmation({ deadline: Date.now() + 28_000 })));
    try {
      const line = () => byClass(mounted.tree, "prompt-card-timer").map((node) => String(node.props.children));
      const said = () => mounted.tree.root.findAll((node) => node.props.role === "status" && String(node.props.children ?? "").includes("Denies")).map((node) => String(node.props.children));
      expect(line()).toEqual(["Denies itself in 28 s"]);
      expect(said()).toEqual(["Denies itself in 28 s"]);
      await act(async () => { jest.advanceTimersByTime(5_000); });
      // the line counts each second, the live region does not follow it
      expect(line()).toEqual(["Denies itself in 23 s"]);
      expect(said()).toEqual(["Denies itself in 28 s"]);
      await act(async () => { jest.advanceTimersByTime(13_000); });
      expect(line()).toEqual(["Denies itself in 10 s"]);
      expect(said()).toEqual(["Denies itself in 10 s"]);
      // at zero the line goes, and the denial is pi's: the card answers nothing here
      await act(async () => { jest.advanceTimersByTime(10_000); });
      expect(line()).toEqual([]);
      expect(mounted.bodies).toEqual([]);
    } finally {
      mounted.restore();
      jest.useRealTimers();
    }
  });

  it("types an editor's answer into six rows, and sends it with Mod+Enter", async () => {
    const mounted = await mount(prompt(typedAnswerCard("editor", { prefill: "line one\nline two" })));
    try {
      const field = mounted.tree.root.findAll((node) => node.type === "textarea")[0]!;
      expect(field.props.rows).toBe(6);
      expect(field.props.value).toBe("line one\nline two");
      await act(async () => { field.props.onKeyDown({ key: "Enter", ctrlKey: true, nativeEvent: { isComposing: false } }); });
      // the line breaks are the answer's own
      expect(JSON.parse(mounted.bodies[0]!)).toEqual({ pane_id: "p1", prompt_id: "p1", custom_text: "line one\nline two" });
    } finally {
      mounted.restore();
    }
  });

  it("answers an input in one line, with Cancel and Send beside the field", async () => {
    const mounted = await mount(prompt(typedAnswerCard("input")));
    try {
      expect(mounted.tree.root.findAll((node) => node.type === "textarea")).toHaveLength(0);
      const field = mounted.tree.root.findAll((node) => node.type === "input")[0]!;
      await act(async () => { field.props.onChange({ currentTarget: { value: "  feature/pi  " } }); });
      const cancel = mounted.tree.root.findAll((node) => node.type === "button" && String(node.props.children) === "Cancel")[0]!;
      const send = mounted.tree.root.findAll((node) => node.type === "button" && String(node.props.children).includes("Send"))[0]!;
      expect(cancel).toBeDefined();
      await act(async () => { send.props.onClick({ nativeEvent: { pointerType: "mouse", detail: 1 }, currentTarget: {} }); });
      expect(JSON.parse(mounted.bodies[0]!)).toEqual({ pane_id: "p1", prompt_id: "p1", custom_text: "feature/pi" });
      // Cancel is pi's cancel: nothing typed is sent
      await act(async () => { cancel.props.onClick({ nativeEvent: { pointerType: "mouse", detail: 1 }, currentTarget: {} }); });
      expect(JSON.parse(mounted.bodies[1]!)).toEqual({ pane_id: "p1", prompt_id: "p1", custom_text: "" });
    } finally {
      mounted.restore();
    }
  });
});

const trust = { folder: "/home/dev/project", found: [".pi/settings.json", ".agents/skills"], message: "Pi needs a project trust decision for this folder" };

describe("the project-trust card", () => {
  it("asks for the folder it stopped on, says what pi found, and never folds", () => {
    const html = renderToStaticMarkup(createElement(SettingsProvider, null, createElement(TrustCard, { trust, onTrust: async () => undefined })));
    // pi cannot continue without it, so there is no fold and no dismiss
    expect(html).not.toContain("prompt-card-fold");
    const words = text(html).replace(/&#x27;/g, "'");
    expect(words).toContain("Trust this project?");
    expect(words).toContain("Pi found settings in this folder that can run code.");
    expect(words).toContain("Trust it only if you know where this folder came from.");
    expect(words).toContain(".pi/settings.json");
    expect(words).toContain("/home/dev/project");
    // the affirmative is at the right, and neither button is the filled one
    expect(words.indexOf("Don't trust")).toBeLessThan(words.indexOf("Trust folder"));
    expect(html).not.toContain("btn-primary");
  });

  it("answers the take-over with the choice, and Esc is Don't trust", async () => {
    const choices: string[] = [];
    const onTrust = async (choice: "approve" | "deny"): Promise<void> => { choices.push(choice); };
    const mounted = await mount(createElement(TrustCard, { trust, onTrust }));
    try {
      const button = (label: string) => mounted.tree.root.findAll((node) => node.type === "button" && String(node.props.children) === label)[0]!;
      await act(async () => { button("Don't trust").props.onClick(); });
      await act(async () => { button("Trust folder").props.onClick(); });
      expect(choices).toEqual(["deny", "approve"]);
      const section = mounted.tree.root.findAll((node) => node.type === "section")[0]!;
      await act(async () => { section.props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} }); });
      expect(choices).toEqual(["deny", "approve", "deny"]);
    } finally {
      mounted.restore();
    }
  });

  it("opens what pi found in the file viewer", async () => {
    const opened: string[] = [];
    const mounted = await mount(createElement(OpenFileContext.Provider, { value: (path: string) => void opened.push(path) }, createElement(TrustCard, { trust, onTrust: async () => undefined })));
    try {
      const views = byClass(mounted.tree, "prompt-card-trust-view");
      expect(views).toHaveLength(2);
      await act(async () => { views[0]!.props.onClick(); });
      expect(opened).toEqual([".pi/settings.json"]);
    } finally {
      mounted.restore();
    }
  });
});

if (languages) Object.defineProperty(navigator, "languages", languages);
