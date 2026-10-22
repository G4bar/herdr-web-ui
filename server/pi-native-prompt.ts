/**
 * The prompt a native pi pane asks through RPC, in the one shape the chat's card already reads.
 *
 * Pi sends an extension's dialog as `extension_ui_request` and blocks until the answer comes back
 * as `extension_ui_response` (docs/rpc-extension-ui.md). The reducer keeps that request as
 * `PiNativeState.uiRequest`; this file maps it to `InteractivePrompt` (for `GET /api/pane/prompt`)
 * and an answer back to the response pi takes, so a native pane and a Terminal one reach the same
 * `PromptCard` through the same API. Nothing here is read off a screen.
 *
 * The prompt's `id` is the request's own id hashed (as `finishPrompt` hashes what a card says): the
 * card polls, and each poll must name the same dialog, while the request after it must not.
 */
import { createHash } from "node:crypto";
import type { InteractivePrompt, PiNativeUiAnswer, PiNativeUiRequest, PromptAnswer } from "../shared/protocol.ts";

/** The card's id for one request: stable across polls, another for pi's next dialog. */
export function nativePromptId(requestId: string): string {
  return createHash("sha256").update(`pi-native\0${requestId}`).digest("hex").slice(0, 12);
}

/** When pi gives up on `request` by itself (epoch ms), or null when it waits for as long as it takes. */
export function nativeDeadline(request: PiNativeUiRequest): number | null {
  return request.timeout === undefined || request.receivedAt === undefined ? null : request.receivedAt + request.timeout;
}

/**
 * `confirm` asks for a yes or no, and pi's own dialog draws it as two rows of equal weight in this
 * order (design §4.7): the affirmative at the right, `Esc` taking the Deny.
 */
const CONFIRM_OPTIONS = ["Deny", "Allow"] as const;

/**
 * The dialog as the chat's card: `select` keeps pi's options as rows, `confirm` becomes the two
 * buttons, and `input`/`editor` have nothing to pick: the answer is typed into their own field.
 * Pi's select options are plain strings, so no row carries a preview.
 */
export function piNativePrompt(request: PiNativeUiRequest): InteractivePrompt {
  const deadline = nativeDeadline(request);
  const timed = deadline === null ? {} : { deadline };
  switch (request.method) {
    case "confirm":
      return {
        id: nativePromptId(request.id), agent: "pi", kind: "approval", variant: "confirm",
        title: request.title, question: request.message ?? "", body: null,
        options: CONFIRM_OPTIONS.map((label) => ({ label, description: null })),
        multi_select: false, custom_option_index: null, ...timed,
      };
    case "input":
    case "editor":
      return {
        id: nativePromptId(request.id), agent: "pi", kind: "question", variant: request.method,
        title: request.title, question: "", body: null,
        // the field alone: its label is pi's own hint, and the card types the answer into it
        options: [{ label: request.placeholder ?? "Type your answer", description: null }],
        multi_select: false, custom_option_index: 0,
        ...(request.prefill === undefined ? {} : { prefill: request.prefill }), ...timed,
      };
    case "select":
      return {
        id: nativePromptId(request.id), agent: "pi", kind: "menu", variant: "select",
        title: request.title, question: "", body: null,
        options: (request.options ?? []).map((label) => ({ label, description: null })),
        multi_select: false, custom_option_index: null, ...timed,
      };
  }
}

/**
 * The answer as pi's `extension_ui_response`: the option's own string for a `select` (or the text
 * typed instead of one), a boolean for a `confirm`, and the typed text for `input`/`editor`. An
 * empty custom answer is the card's Skip, and a cancel to pi, as Esc is. `invalid` names what the
 * dialog cannot take, for the answer route's own 400.
 */
export function piNativeAnswer(request: PiNativeUiRequest, answer: PromptAnswer): { answer: PiNativeUiAnswer } | { invalid: string } {
  const typed = answer.custom_text;
  const skipped = typed !== undefined && typed.trim() === "";
  if (answer.option_indices !== undefined) return { invalid: "This prompt takes one answer." };
  switch (request.method) {
    case "confirm": {
      // Skip on a confirmation is pi's cancel, which its extension reads as false, like Deny
      if (typed !== undefined) return skipped ? { answer: { cancelled: true } } : { invalid: "This prompt takes Deny or Allow." };
      if (answer.option_index === undefined) return { invalid: "Deny or Allow is required." };
      if (answer.option_index !== 0 && answer.option_index !== 1) return { invalid: "An option index is outside the displayed range." };
      return { answer: { confirmed: answer.option_index === 1 } };
    }
    case "select": {
      if (answer.option_index !== undefined) {
        const choice = request.options?.[answer.option_index];
        if (choice === undefined) return { invalid: "An option index is outside the displayed range." };
        return { answer: { value: choice } };
      }
      if (typed === undefined) return { invalid: "One option or a typed answer is required." };
      return skipped ? { answer: { cancelled: true } } : { answer: { value: typed } };
    }
    case "input":
    case "editor": {
      if (typed === undefined) return { invalid: "A typed answer is required." };
      // an editor's answer keeps its line breaks and its own spacing; an input's is one line
      return skipped ? { answer: { cancelled: true } } : { answer: { value: request.method === "editor" ? typed : typed.trim() } };
    }
  }
}
