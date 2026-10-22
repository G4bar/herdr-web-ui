import { describe, expect, it } from "bun:test";
import type { PanePromptResponse, PiNativeState, PiNativeUiAnswer, PiNativeUiRequest, PromptAnswer } from "../shared/protocol.ts";
import type { PiNativeControl } from "./pi-native.ts";
import { PiNativeError } from "./pi-native.ts";
import { nativeDeadline, nativePromptId, piNativeAnswer, piNativePrompt } from "./pi-native-prompt.ts";
import { initialPiNativeState } from "./pi-rpc.ts";
import { handlePromptRequest } from "./prompt.ts";

// A native pane's dialog is pi's own `extension_ui_request`, so these need no pane, screen or herdr:
// the registry is the fake, and an answer is whatever it was handed to respond with.

const paneId = "w:p1";

function control(state: PiNativeState | null, answers: { id: string; answer: PiNativeUiAnswer }[] = [], onRespond?: () => void): PiNativeControl {
  return {
    state: () => state,
    sessionFile: () => null,
    call: async () => ({}),
    respond: (_paneId, id, answer) => { if (onRespond) onRespond(); answers.push({ id, answer }); },
    onState: () => () => undefined,
    takeover: async () => initialPiNativeState(),
    handBack: async () => undefined,
    reconnect: async () => initialPiNativeState(),
    prune: () => undefined,
  };
}

const dialog = (patch: Partial<PiNativeUiRequest> = {}): PiNativeUiRequest => ({
  id: "req-7", method: "select", title: "Which database?", options: ["Postgres", "SQLite"], ...patch,
});

const nativeState = (uiRequest: PiNativeUiRequest | null): PiNativeState => ({ ...initialPiNativeState(), mode: "native", uiRequest });

const getPrompt = async (registry: PiNativeControl): Promise<PanePromptResponse> => {
  const url = new URL(`http://ovis/api/pane/prompt?pane_id=${paneId}`);
  const response = await handlePromptRequest(new Request(url), url, { piNative: registry });
  return await response!.json() as PanePromptResponse;
};

const answer = async (registry: PiNativeControl, body: Omit<PromptAnswer, "pane_id">): Promise<Response> => {
  const url = new URL("http://ovis/api/pane/prompt/answer");
  return (await handlePromptRequest(new Request(url, { method: "POST", body: JSON.stringify({ pane_id: paneId, ...body }) }), url, { piNative: registry }))!;
};

describe("a native dialog as the chat's card", () => {
  it("names one dialog the same on every poll, and pi's next one differently", () => {
    expect(nativePromptId("req-7")).toBe(nativePromptId("req-7"));
    expect(nativePromptId("req-7")).not.toBe(nativePromptId("req-8"));
  });

  it("keeps a select's options as rows", () => {
    const prompt = piNativePrompt(dialog());
    expect(prompt).toMatchObject({
      id: nativePromptId("req-7"), agent: "pi", kind: "menu", variant: "select",
      title: "Which database?", question: "", custom_option_index: null, multi_select: false,
    });
    expect(prompt.options.map((option) => option.label)).toEqual(["Postgres", "SQLite"]);
    expect(prompt.options.every((option) => option.preview === undefined)).toBe(true);
  });

  it("asks a confirm as Deny | Allow under pi's own message", () => {
    const prompt = piNativePrompt(dialog({ method: "confirm", message: "All messages will be lost." }));
    expect(prompt).toMatchObject({ agent: "pi", kind: "approval", variant: "confirm", title: "Which database?", question: "All messages will be lost." });
    expect(prompt.options.map((option) => option.label)).toEqual(["Deny", "Allow"]);
  });

  it("gives input and editor their own field, with pi's hint and the editor's prefill", () => {
    const input = piNativePrompt(dialog({ method: "input", placeholder: "type something..." }));
    expect(input).toMatchObject({ kind: "question", variant: "input", custom_option_index: 0, question: "" });
    expect(input.options.map((option) => option.label)).toEqual(["type something..."]);
    expect(input.prefill).toBeUndefined();
    const editor = piNativePrompt(dialog({ method: "editor", prefill: "Line 1\nLine 2" }));
    expect(editor).toMatchObject({ variant: "editor", custom_option_index: 0, prefill: "Line 1\nLine 2" });
  });

  it("counts its timer down from when the bridge read the request, not from each poll", () => {
    const timed = dialog({ timeout: 30_000, receivedAt: 1_000 });
    expect(nativeDeadline(timed)).toBe(31_000);
    expect(piNativePrompt(timed).deadline).toBe(31_000);
    expect(piNativePrompt({ ...timed, receivedAt: 2_000 }).deadline).toBe(32_000);
    // pi waits without a limit when it names none, and the card draws no timer line
    expect(piNativePrompt(dialog()).deadline).toBeUndefined();
    expect(nativeDeadline(dialog({ timeout: 30_000 }))).toBeNull();
  });
});

describe("an answer back to pi", () => {
  it("is the option's own string, the typed one, or a confirm's boolean", () => {
    expect(piNativeAnswer(dialog(), { pane_id: paneId, prompt_id: "x", option_index: 1 })).toEqual({ answer: { value: "SQLite" } });
    expect(piNativeAnswer(dialog(), { pane_id: paneId, prompt_id: "x", custom_text: "DuckDB" })).toEqual({ answer: { value: "DuckDB" } });
    expect(piNativeAnswer(dialog({ method: "confirm" }), { pane_id: paneId, prompt_id: "x", option_index: 0 })).toEqual({ answer: { confirmed: false } });
    expect(piNativeAnswer(dialog({ method: "confirm" }), { pane_id: paneId, prompt_id: "x", option_index: 1 })).toEqual({ answer: { confirmed: true } });
    expect(piNativeAnswer(dialog({ method: "input" }), { pane_id: paneId, prompt_id: "x", custom_text: "  my-db  " })).toEqual({ answer: { value: "my-db" } });
    // an editor's answer is its whole text, line breaks and all
    expect(piNativeAnswer(dialog({ method: "editor" }), { pane_id: paneId, prompt_id: "x", custom_text: " one\ntwo " })).toEqual({ answer: { value: " one\ntwo " } });
  });

  it("takes Skip as pi's cancel, which a confirmation reads as a denial", () => {
    for (const method of ["select", "confirm", "input", "editor"] as const) {
      expect(piNativeAnswer(dialog({ method }), { pane_id: paneId, prompt_id: "x", custom_text: "" })).toEqual({ answer: { cancelled: true } });
    }
  });

  it("refuses an answer the dialog cannot take", () => {
    expect(piNativeAnswer(dialog(), { pane_id: paneId, prompt_id: "x", option_index: 2 })).toMatchObject({ invalid: expect.any(String) });
    expect(piNativeAnswer(dialog(), { pane_id: paneId, prompt_id: "x", option_indices: [0] })).toMatchObject({ invalid: expect.any(String) });
    expect(piNativeAnswer(dialog(), { pane_id: paneId, prompt_id: "x" })).toMatchObject({ invalid: expect.any(String) });
    expect(piNativeAnswer(dialog({ method: "confirm" }), { pane_id: paneId, prompt_id: "x", custom_text: "yes" })).toMatchObject({ invalid: expect.any(String) });
    expect(piNativeAnswer(dialog({ method: "input" }), { pane_id: paneId, prompt_id: "x", option_index: 0 })).toMatchObject({ invalid: expect.any(String) });
  });
});

describe("the prompt route for a native pane", () => {
  it("serves pi's dialog as the card, with no screen read", async () => {
    const { prompt } = await getPrompt(control(nativeState(dialog())));
    expect(prompt).toMatchObject({ variant: "select", title: "Which database?" });
    expect(prompt!.id).toBe(nativePromptId("req-7"));
  });

  it("serves none while pi asks nothing", async () => {
    expect((await getPrompt(control(nativeState(null)))).prompt).toBeNull();
  });

  it("serves none for a dialog pi has already given up on", async () => {
    const expired = dialog({ timeout: 1, receivedAt: Date.now() - 5_000 });
    expect((await getPrompt(control(nativeState(expired)))).prompt).toBeNull();
  });

  it("answers over RPC by the request pi named, not by the card's id", async () => {
    const answers: { id: string; answer: PiNativeUiAnswer }[] = [];
    const response = await answer(control(nativeState(dialog()), answers), { prompt_id: nativePromptId("req-7"), option_index: 0 });
    expect(response.status).toBe(200);
    expect(answers).toEqual([{ id: "req-7", answer: { value: "Postgres" } }]);
  });

  it("refuses a card read before pi moved on, and sends nothing", async () => {
    const answers: { id: string; answer: PiNativeUiAnswer }[] = [];
    const registry = control(nativeState(dialog()), answers);
    expect((await answer(registry, { prompt_id: nativePromptId("req-6"), option_index: 0 })).status).toBe(409);
    expect(await (await answer(registry, { prompt_id: nativePromptId("req-7"), option_index: 0 })).json()).toEqual({ ok: true });
    expect(answers).toHaveLength(1);
  });

  it("refuses an answer to a dialog pi has already given up on", async () => {
    const answers: { id: string; answer: PiNativeUiAnswer }[] = [];
    const expired = dialog({ timeout: 1, receivedAt: Date.now() - 5_000 });
    const response = await answer(control(nativeState(expired), answers), { prompt_id: nativePromptId("req-7"), option_index: 0 });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("prompt_changed");
    expect(answers).toEqual([]);
  });

  it("refuses an answer the dialog cannot take, as invalid_answer", async () => {
    const answers: { id: string; answer: PiNativeUiAnswer }[] = [];
    const response = await answer(control(nativeState(dialog()), answers), { prompt_id: nativePromptId("req-7"), option_index: 9 });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_answer");
    expect(answers).toEqual([]);
  });

  it("keeps the dialog waiting when the answer could not be written to pi", async () => {
    const answers: { id: string; answer: PiNativeUiAnswer }[] = [];
    const registry = control(nativeState(dialog()), answers, () => { throw new PiNativeError("not_connected", "the answer could not be sent to pi in this pane", 409); });
    const response = await answer(registry, { prompt_id: nativePromptId("req-7"), option_index: 0 });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("prompt_changed");
    expect(answers).toEqual([]);
    // pi is still blocked on it: the card is not taken as answered
    expect((await getPrompt(registry)).prompt?.id).toBe(nativePromptId("req-7"));
  });
});
