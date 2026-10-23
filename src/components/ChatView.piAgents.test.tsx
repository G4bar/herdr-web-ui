import { describe, expect, it } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConversationTurn, HerdsmanAgent, PiNativeHerdsman } from "../../shared/protocol.ts";
import { herdsmanTurnAgents } from "../lib/herdsman.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { HerdsmanTurnCards } from "./ChatView.tsx";

const render = (children: ReactNode): string => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

const delegated = (label: string): ConversationTurn => ({
  role: "assistant", ts: null, parts: [{ kind: "tool", name: "delegate_agent", summary: `Delegated ${label}`, input: JSON.stringify({ label }), output: "" }],
});
const said = (text: string): ConversationTurn => ({ role: "assistant", ts: null, parts: [{ kind: "text", text }] });
const agent = (label: string, extra: Partial<HerdsmanAgent> = {}): HerdsmanAgent => ({ label, definition: "scout", parent: null, state: "finished", ...extra });
const snapshot = (...agents: HerdsmanAgent[]): PiNativeHerdsman => ({ agents, capabilities: ["steer", "reply", "close"] });

/** The card a turn's own entry draws, exactly as ChatView places it after the turn. */
const cardsFor = (turns: readonly ConversationTurn[], herdsman: PiNativeHerdsman | null, index: number, onOpenAgent?: (label: string) => void): string => {
  const entry = herdsmanTurnAgents(turns, herdsman).get(index);
  return entry === undefined ? "" : render(createElement(HerdsmanTurnCards, { entry, onOpenAgent }));
};

describe("Herdsman agents in the transcript", () => {
  it("draws one results card under the turn that delegated the agent", () => {
    const turns = [delegated("scout_ui"), said("all done")];
    const html = cardsFor(turns, snapshot(agent("scout_ui", { startedAt: 1_000, endedAt: 72_000, toolCalls: 14, tokens: 38_000 })), 0);

    expect(html.match(/class="chat-task-results"/g)).toHaveLength(1);
    expect(html).toContain("1 agent finished");
    expect(html).toContain("scout_ui");
    expect(html).toContain("scout");
    expect(html).toContain("1m 11s");
    expect(html).toContain("14 tool calls");
    expect(html).toContain("38k tokens");
    expect(html).toContain("Done");
    // the earlier turn takes the card, not the one after it
    expect(cardsFor(turns, snapshot(agent("scout_ui")), 1)).toBe("");
  });

  it("draws a failed agent's row as failed, and still draws one no call names", () => {
    const turns = [said("the lead delegated nothing here")];
    const html = cardsFor(turns, snapshot(agent("broke", { definition: "designer", state: "failed" })), 0);

    expect(html).toContain("1 agent finished");
    expect(html).toContain("broke");
    expect(html).toContain("is-failed");
    expect(html).toContain("Failed");
  });

  it("draws a child agent's question with the way into its reply field", () => {
    const turns = [delegated("visual_designer"), said("waiting")];
    const html = cardsFor(turns, snapshot(agent("visual_designer", { definition: "designer", state: "asks", question: { text: "Postgres or SQLite?", files: ["db/schema.sql"] } })), 0, () => {});

    expect(html).toContain("visual_designer asks: Postgres or SQLite?");
    expect(html).toContain("db/schema.sql");
    expect(html).toContain(">Reply<");
    // a question row is not a result card: it holds no answer to fold
    expect(html).not.toContain("agents finished");
  });

  it("draws nothing without a roster, or when no agent ended or asks", () => {
    const turns = [delegated("scout_ui")];

    expect(cardsFor(turns, null, 0)).toBe("");
    expect(cardsFor(turns, snapshot(agent("scout_ui", { state: "running" }), agent("gone", { state: "closed" })), 0)).toBe("");
  });
});
