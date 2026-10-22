import { describe, expect, it } from "bun:test";
import type { PiNativeState } from "../../shared/protocol.ts";
import type { PiNativeControl } from "../pi-native.ts";
import { initialPiNativeState } from "../pi-rpc.ts";
import { createSubmitText, pendingFault } from "./composer.ts";

// A native pane has no terminal input: the composer's message is a Pi RPC `prompt`, and nothing here
// reaches herdr, so these tests need no pane, child or socket.

type Sent = Record<string, unknown>[];

function native(state: PiNativeState | null, sent: Sent, refusal?: string): PiNativeControl {
  return {
    state: () => state,
    sessionFile: () => null,
    call: async (_paneId, command) => {
      sent.push(command);
      if (refusal !== undefined) throw new Error(refusal);
      return { disposition: "started" };
    },
    onState: () => () => undefined,
    takeover: async () => initialPiNativeState(),
    handBack: async () => undefined,
    reconnect: async () => initialPiNativeState(),
    prune: () => undefined,
  };
}

const submitter = (piNative: PiNativeControl) => createSubmitText({
  options: { piNative }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});

const nativeState = (patch: Partial<PiNativeState> = {}): PiNativeState => ({ ...initialPiNativeState(), mode: "native", ...patch });

describe("a native Pi pane's composer message", () => {
  it("is a plain prompt while Pi is idle", async () => {
    const sent: Sent = [];
    await submitter(native(nativeState(), sent))("w:p1", "fix the crash", "", Date.now());
    expect(sent).toEqual([{ type: "prompt", message: "fix the crash" }]);
  });

  it("steers a running turn by default and follows up on request", async () => {
    const steering: Sent = [];
    await submitter(native(nativeState({ isStreaming: true }), steering))("w:p1", "also the header", "", Date.now());
    expect(steering).toEqual([{ type: "prompt", message: "also the header", streamingBehavior: "steer" }]);
    const following: Sent = [];
    await submitter(native(nativeState({ isStreaming: true }), following))("w:p1", "then run the tests", "", Date.now(), false, () => {}, undefined, undefined, false, "followUp");
    expect(following).toEqual([{ type: "prompt", message: "then run the tests", streamingBehavior: "followUp" }]);
  });

  it("refuses to type into a child that is gone, and keeps Pi's own refusal as the submit's fault", async () => {
    const sent: Sent = [];
    await expect(submitter(native(nativeState({ mode: "lost" }), sent))("w:p1", "hello", "", Date.now())).rejects.toMatchObject({ code: "pi_lost" });
    expect(sent).toEqual([]);
    const refused = submitter(native(nativeState(), sent, "no model selected"))("w:p1", "hello", "", Date.now()).catch((error: unknown) => error);
    expect(pendingFault(await refused)).toEqual({ code: "submit_failed", message: "no model selected" });
  });

  it("takes Pi's refusal of a send read as idle as the submit's own failure", async () => {
    // the turn began between the state read and the write: pi refuses a plain prompt, and nothing is lost from the chat
    const sent: Sent = [];
    const error = await submitter(native(nativeState(), sent, "a turn is running; pass streamingBehavior"))("w:p1", "hello", "", Date.now())
      .catch((error: unknown) => error);
    expect(sent).toEqual([{ type: "prompt", message: "hello" }]);
    expect(pendingFault(error)).toEqual({ code: "submit_failed", message: "a turn is running; pass streamingBehavior" });
  });
});
