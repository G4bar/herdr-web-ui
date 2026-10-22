import { afterEach, expect, it, mock } from "bun:test";
import { ReplayBuffer } from "../output-window.ts";
import { connectionData, type Client } from "./connections.ts";
import type { PaneAttachment } from "./terminal-process.ts";
import { initialPiNativeState } from "../pi-rpc.ts";
import type { PiNativeState, ServerMessage } from "../../shared/protocol.ts";

let attachment: PaneAttachment;
mock.module("./terminal-process.ts", () => ({
  ATTACH_HELD_MESSAGE: "Held",
  createSpawnAttachment: ({ attachments }: { attachments: Map<string, PaneAttachment> }) => ({
    spawnAttachment: async (pane: string) => { attachments.set(pane, attachment); return attachment; },
  }),
}));
const { createNativeStatePush, createTerminalRegistry } = await import("./terminals.ts");

afterEach(() => mock.restore());

async function join({ readOnly = false, ready, recovering, times = 1 }: { readOnly?: boolean; ready: boolean; recovering?: boolean; times?: number }): Promise<ServerMessage[]> {
  const frames: ServerMessage[] = [];
  const client = {
    data: connectionData({ deviceId: undefined, readOnly }), readyState: WebSocket.OPEN,
    getBufferedAmount: () => 0, send: (text: string) => { frames.push(JSON.parse(text)); return text.length; },
    close() {},
  } as unknown as Client;
  const replay = new ReplayBuffer(1024);
  replay.append("retained screen");
  attachment = {
    kind: "pty", ready, ...(recovering === undefined ? {} : { recovering }), cols: 80, rows: 24, clients: new Set(), grids: new Map(), stalled: new Map(), replay,
    process: { exited: Promise.resolve(), pause() {}, resume() {}, resize() {}, winch() {}, kill() {}, write() {} } as unknown as Extract<PaneAttachment, { kind: "pty" }>["process"],
  };
  const registry = createTerminalRegistry({
    options: {}, clients: new Set([client]), stopped: () => false, terminalAttach: async () => true,
    holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 0,
    holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() {}, end() {},
  });
  for (let attach = 0; attach < times; attach++) await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true });
  registry.closeAttachment("p");
  registry.conversations.stop();
  return frames;
}

for (const readOnly of [false, true]) for (const ready of [false, true]) {
  it(`preserves input readiness ${ready} after replay for an ${readOnly ? "observer" : "owner"} joining a shared attach`, async () => {
    const frames = await join({ readOnly, ready });
    expect(frames.filter((frame) => frame.type === "pty-data")).toEqual([
      // the joiner's replay, marked as the screen from before, byte for byte
      { type: "pty-data", pane_id: "p", data: "retained screen", replay: true },
    ]);
    // An input-ready receipt is the existing attach-complete barrier for queued input,
    // not an output-presentation notification. No early negative receipt may satisfy it.
    expect(frames.filter((frame) => frame.type === "input-ready")).toEqual(
      ready ? [{ type: "input-ready", pane_id: "p" }] : [],
    );
    if (ready) expect(frames.findIndex((frame) => frame.type === "input-ready"))
      .toBeGreaterThan(frames.findIndex((frame) => frame.type === "pty-data"));
    expect(frames.some((frame) => frame.type === "output-recovering")).toBe(false);
  });
}

for (const readOnly of [false, true]) {
  it(`tells an ${readOnly ? "observer" : "owner"} joining a recovering attach that its replay is the screen from before, once`, async () => {
    const frames = await join({ readOnly, ready: false, recovering: true, times: 2 });
    expect(frames.filter((frame) => frame.type === "output-recovering")).toEqual([{ type: "output-recovering", pane_id: "p" }]);
    expect(frames.findIndex((frame) => frame.type === "output-recovering"))
      .toBeLessThan(frames.findIndex((frame) => frame.type === "pty-data"));
    // presentation only: the queued-input barrier still waits for the attach to take
    expect(frames.filter((frame) => frame.type === "input-ready")).toEqual([]);
  });
}

function watching(interested: boolean): { client: Client; frames: ServerMessage[] } {
  const frames: ServerMessage[] = [];
  const data = connectionData({ deviceId: undefined, readOnly: false });
  data.attached.set("p", { keepSize: false });
  if (interested) data.conversationInterests.add("p");
  const client = {
    data, readyState: WebSocket.OPEN,
    getBufferedAmount: () => 0, send: (text: string) => { frames.push(JSON.parse(text)); return text.length; },
    close() {},
  } as unknown as Client;
  return { client, frames };
}

it("pushes a native pane's state to the clients watching it, throttled, with a mode change at once", async () => {
  const watcher = watching(true);
  const attachedOnly = watching(false);
  let state: PiNativeState = { ...initialPiNativeState(), mode: "native" };
  const push = createNativeStatePush({ clients: new Set([watcher.client, attachedOnly.client]), state: () => state, intervalMs: 10 });

  // once on watch, and only to a client interested in this pane's conversation
  push.watch("p");
  expect(watcher.frames).toEqual([{ type: "pi-native-state", pane_id: "p", state }]);
  expect(attachedOnly.frames).toEqual([]);

  // a stream of same-mode changes reaches the client once per interval, carrying the newest state
  state = { ...state, thinkingLevel: "high" };
  push.changed("p", state);
  state = { ...state, isStreaming: true };
  push.changed("p", state);
  const settled = async (frames: number): Promise<void> => {
    const deadline = Date.now() + 1_000;
    while (watcher.frames.length < frames) {
      if (Date.now() > deadline) throw new Error(`expected ${frames} pushes, got ${watcher.frames.length}`);
      await Bun.sleep(5);
    }
  };
  await settled(2);
  expect(watcher.frames[1]).toMatchObject({ state: { thinkingLevel: "high", isStreaming: true } });

  // a mode change leaves at once: the chat's own controls hang on it
  state = { ...state, mode: "lost", isStreaming: false };
  push.changed("p", state);
  expect(watcher.frames).toHaveLength(3);
  expect(watcher.frames[2]).toMatchObject({ state: { mode: "lost" } });
  push.forget("p");
});
