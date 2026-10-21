import { expect, it } from "bun:test";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

import type { InteractivePrompt } from "./shared/protocol.ts";
import { SettingsProvider } from "./src/lib/settings.ts";
import { PromptCard } from "./src/components/PromptCard.tsx";

const store = new Map<string, string>();
const media = { matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false };
const style = { setProperty() {}, removeProperty() {} };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } } });
Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => media, getSelection: () => null, addEventListener() {}, removeEventListener() {}, localStorage: globalThis.localStorage } });
Object.defineProperty(globalThis, "document", { configurable: true, value: {
  addEventListener() {}, removeEventListener() {}, activeElement: null, querySelector: () => null,
  documentElement: { dataset: {}, style, lang: "", colorScheme: "" },
  getSelection: () => null,
} });

const prompt: InteractivePrompt = {
  id: "p1", agent: "pi", kind: "question", title: "Layout", question: "Which layout?",
  body: null, custom_option_index: 2, multi_select: false,
  options: [{ label: "Sidebar", description: null, preview: "+---+" }, { label: "Tabs", description: null }],
};

it("mounts", async () => {
  let tree!: TestRenderer.ReactTestRenderer;
  const render = (typedAnswer: { option_index: number } | null) => createElement(SettingsProvider, null, createElement(PromptCard, { paneId: "p", prompt, typedAnswer, onPromptChanged() {}, onAnswered() {} }));
  await act(async () => { tree = TestRenderer.create(render(null)); });
  const inputs = tree.root.findAll((node) => node.type === "input");
  console.log("inputs", inputs.length, inputs.map((i) => i.props.checked));
  await act(async () => { inputs[0]!.props.onChange(); });
  console.log("after click", tree.root.findAll((node) => node.type === "input").map((i) => i.props.checked));
  await act(async () => { tree.update(render({ option_index: 1 })); });
  console.log("typed", tree.root.findAll((node) => node.type === "input").map((i) => i.props.checked));
});
