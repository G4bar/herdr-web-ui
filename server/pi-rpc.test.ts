import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiNativeState } from "../shared/protocol.ts";
import { consumeEditorText, initialPiNativeState, NOTICE_LIMIT, PiRpc, reducePiEvent, TAIL_LINE_CHARS, TAIL_LINES } from "./pi-rpc.ts";

// A fake pi on the other end of the RPC pipe: it answers commands by type, answers `get_state`
// late (pi's handlers are async, so responses arrive out of order) and streams the records framing
// has to survive. String.raw keeps the \u2028 escapes in the script source as escapes.
const FAKE_PI = String.raw`
const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const respond = (command, data) => send({ id: command.id, type: "response", command: command.type, success: true, data });
const refuse = (command, error) => send({ id: command.id, type: "response", command: command.type, success: false, error });

const startup = () => {
  // one record in two writes, the split in the middle of the JSON: nothing else is written until
  // the second half is out, so no record is ever interleaved into another
  const split = JSON.stringify({ type: "session_info_changed", name: "split-name" }) + "\n";
  process.stdout.write(split.slice(0, 12));
  setTimeout(() => {
    process.stdout.write(split.slice(12));
    // U+2028 and U+2029 are characters inside a record, not its end
    send({ type: "extension_ui_request", id: "n1", method: "notify", message: "sep\u2028and\u2029inside", notifyType: "warning" });
    // pi's answer to a malformed command carries no id of ours
    send({ type: "response", command: "parse", success: false, error: "Failed to parse command: Unexpected token" });
    send({ type: "extension_ui_request", id: "sel-1", method: "select", title: "Allow dangerous command?", options: ["Allow", "Block"] });
    listen();
  }, 40);
};

const handle = (command) => {
  switch (command.type) {
    case "get_state":
      setTimeout(() => respond(command, {
        model: { provider: "anthropic", id: "claude-test", name: "Claude Test", contextWindow: 200000, reasoning: true },
        thinkingLevel: "low", isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "one-at-a-time",
        sessionFile: "/tmp/pi-session.jsonl", sessionId: "s1", sessionName: "test session", autoCompactionEnabled: true,
        messageCount: 0, pendingMessageCount: 0,
      }), 40);
      break;
    case "get_available_models":
      respond(command, { models: [{ id: "claude-test" }] });
      break;
    case "get_session_stats":
      respond(command, {
        sessionId: "s1", userMessages: 2, assistantMessages: 2, toolCalls: 3, toolResults: 3, totalMessages: 4,
        tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 }, cost: 0.5,
        contextUsage: { tokens: 110, contextWindow: 200000, percent: 1 },
      });
      break;
    case "message_end":
      send({ type: "message_end", message: { role: "assistant", usage: { input: 5, output: 2, totalTokens: 7, cost: { total: 0.01 } } } });
      respond(command, {});
      break;
    case "set_model":
      refuse(command, "Model not found: invalid/model");
      break;
    case "bash":
      for (const delta of ["one\n", "two\n", "three\n"]) send({ type: "bash_execution_update", id: command.id, delta });
      respond(command, { output: "one\ntwo\nthree\n", exitCode: 0, cancelled: false });
      break;
    case "hang":
      break;
    // one answer and gone: the exit races the response it just wrote
    case "respond-then-quit":
      send({ id: command.id, type: "response", command: "respond-then-quit", success: true, data: { ok: true } });
      process.exit(0);
      break;
    case "quit":
      process.exit(0);
  }
};

function listen() {
  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffered += chunk;
    let at = buffered.indexOf("\n");
    while (at >= 0) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      at = buffered.indexOf("\n");
      if (line.trim() === "") continue;
      const record = JSON.parse(line);
      // the answer to a dialog comes back on stdin: echo it so the test can see it landed
      if (record.type === "extension_ui_response") send({ type: "extension_ui_request", id: "echo", method: "notify", message: "answer:" + (record.value ?? record.confirmed ?? record.cancelled) });
      else handle(record);
    }
  });
}
startup();
`;

const roots: string[] = [];
const clients: PiRpc[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A client on a fake pi, its diagnostics collected so a test can read what was logged. */
function start(): { rpc: PiRpc; logged: string[] } {
  const root = mkdtempSync(join(tmpdir(), "ovis-pi-rpc-"));
  roots.push(root);
  const script = join(root, "fake-pi.ts");
  writeFileSync(script, FAKE_PI);
  const logged: string[] = [];
  const rpc = new PiRpc({
    sessionFile: join(root, "session.jsonl"),
    cwd: root,
    bin: [process.execPath, script],
    env: { ...process.env, PI_RPC_TEST: "1" },
    log: (line) => logged.push(line),
  });
  clients.push(rpc);
  return { rpc, logged };
}

/** Wait for a condition the child reaches on its own schedule. */
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("condition not reached");
    await Bun.sleep(10);
  }
}

describe("PiRpc", () => {
  it("correlates responses by id, not by arrival", async () => {
    const { rpc } = start();
    const order: string[] = [];
    const state = rpc.call({ type: "get_state" }).then((data) => { order.push("state"); return data; });
    const models = rpc.call({ type: "get_available_models" }).then((data) => { order.push("models"); return data; });
    expect(await models).toEqual({ models: [{ id: "claude-test" }] });
    expect(await state).toMatchObject({ thinkingLevel: "low", sessionName: "test session" });
    // get_state was answered 40ms late, so its response came second
    expect(order).toEqual(["models", "state"]);
  });

  it("seeds the state from get_state and get_session_stats", async () => {
    const { rpc } = start();
    await rpc.call({ type: "get_state" });
    await rpc.call({ type: "get_session_stats" });
    const state = rpc.state;
    expect(state.mode).toBe("native");
    expect(state.model).toEqual({ provider: "anthropic", id: "claude-test", name: "Claude Test", contextWindow: 200000, reasoning: true });
    expect(state.thinkingLevel).toBe("low");
    expect(state.followUpMode).toBe("one-at-a-time");
    expect(state.sessionFile).toBe("/tmp/pi-session.jsonl");
    expect(state.sessionName).toBe("test session");
    expect(state.stats).toMatchObject({ userMessages: 2, assistantMessages: 2, cost: 0.5, contextUsage: { tokens: 110, contextWindow: 200000, percent: 1 } });
  });

  it("adds a finished message's usage to the session totals", async () => {
    const { rpc } = start();
    await rpc.call({ type: "get_session_stats" });
    await rpc.call({ type: "message_end" });
    await until(() => rpc.state.stats?.assistantMessages === 3);
    expect(rpc.state.stats).toMatchObject({ tokens: { input: 105, output: 22, total: 127 }, cost: 0.51 });
  });

  it("keeps a split record and a U+2028 message whole", async () => {
    const { rpc } = start();
    await until(() => rpc.state.sessionName === "split-name" && rpc.state.notices.length === 1);
    expect(rpc.state.notices[0]?.message).toBe("sep\u2028and\u2029inside");
    expect(rpc.state.notices[0]?.type).toBe("warning");
    expect(rpc.state.uiRequest).toMatchObject({ id: "sel-1", method: "select", title: "Allow dangerous command?", options: ["Allow", "Block"] });
  });

  it("logs a parse response and an answered dialog instead of waiting on them", async () => {
    const { rpc, logged } = start();
    await until(() => logged.some((line) => line.includes("unsolicited response: parse")));
    expect(rpc.state.uiRequest?.id).toBe("sel-1");
    rpc.respond("sel-1", { value: "Allow" });
    // the dialog stops pending the moment its answer goes back, so a card cannot outlive it
    expect(rpc.state.uiRequest).toBeNull();
    await until(() => rpc.state.notices.some((notice) => notice.message === "answer:Allow"));
  });

  it("rejects a refused command with pi's own error", async () => {
    const { rpc } = start();
    await expect(rpc.call({ type: "set_model", provider: "invalid", modelId: "invalid/model" })).rejects.toThrow("Model not found: invalid/model");
  });

  it("rejects calls still pending when the child exits", async () => {
    const { rpc } = start();
    const outcomes = await Promise.allSettled([rpc.call({ type: "hang" }), rpc.call({ type: "quit" })]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(outcomes.map((outcome) => (outcome.status === "rejected" ? String(outcome.reason) : ""))).toEqual(["Error: pi exited (0)", "Error: pi exited (0)"]);
    await until(() => rpc.state.mode === "lost");
    expect(rpc.state.uiRequest).toBeNull();
    await expect(rpc.call({ type: "get_state" })).rejects.toThrow("pi has exited");
  });

  it("resolves a response written just before the child exited, and stays lost", async () => {
    const { rpc } = start();
    await expect(rpc.call({ type: "respond-then-quit" })).resolves.toEqual({ ok: true });
    await until(() => rpc.state.mode === "lost");
    // a record read after the exit cannot bring the state back to life
    await Bun.sleep(50);
    expect(rpc.state.mode).toBe("lost");
    expect(rpc.state.isStreaming).toBe(false);
  });

  it("drops a direct bash command's output once it answered", async () => {
    const { rpc } = start();
    await rpc.call({ type: "bash", command: "printf one" });
    expect(rpc.state.toolTails).toEqual({});
  });
});

describe("reducePiEvent", () => {
  const reduced = (state: PiNativeState, events: Record<string, unknown>[]): PiNativeState => events.reduce(reducePiEvent, state);

  it("takes the queue as queue_update reports it", () => {
    const state = reduced(initialPiNativeState(), [{ type: "queue_update", steering: ["stop this"], followUp: ["then this", "then that"] }]);
    expect(state.queue).toEqual({ steering: ["stop this"], followUp: ["then this", "then that"] });
  });

  it("holds the retry in flight and drops it when it ends", () => {
    const started = reducePiEvent(initialPiNativeState(), { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" });
    expect(started.retry).toEqual({ attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" });
    expect(reducePiEvent(started, { type: "auto_retry_end", success: true, attempt: 2 }).retry).toBeNull();
  });

  it("keeps one dialog pending and reads fire-and-forget calls without one", () => {
    const dialog = reducePiEvent(initialPiNativeState(), { type: "extension_ui_request", id: "d1", method: "confirm", title: "Clear session?", message: "All messages will be lost." });
    expect(dialog.uiRequest).toMatchObject({ id: "d1", method: "confirm", message: "All messages will be lost." });

    const fireAndForget = reduced(initialPiNativeState(), [
      { type: "extension_ui_request", id: "f1", method: "notify", message: "Command blocked", notifyType: "error" },
      { type: "extension_ui_request", id: "f2", method: "setStatus", statusKey: "herdsman", statusText: "2 agents" },
      { type: "extension_ui_request", id: "f3", method: "setStatus", statusKey: "stash" },
      { type: "extension_ui_request", id: "f4", method: "setWidget", widgetKey: "w", widgetLines: ["a", "b"] },
      { type: "extension_ui_request", id: "f5", method: "setWidget", widgetKey: "w" },
      { type: "extension_ui_request", id: "f6", method: "set_editor_text", text: "prefilled" },
      { type: "extension_ui_request", id: "f7", method: "setTitle", title: "pi - x" },
    ]);
    expect(fireAndForget.uiRequest).toBeNull();
    expect(fireAndForget.notices).toEqual([{ id: "f1", type: "error", message: "Command blocked" }]);
    expect(fireAndForget.statuses).toEqual({ herdsman: "2 agents" });
    expect(fireAndForget.widgets).toEqual({});
    expect(fireAndForget.editorText).toBe("prefilled");
    expect(consumeEditorText(fireAndForget).editorText).toBeNull();
  });

  it("caps the notices", () => {
    const state = reduced(initialPiNativeState(), Array.from({ length: NOTICE_LIMIT + 5 }, (_, index) => ({ type: "extension_ui_request", id: `n${index}`, method: "notify", message: `notice ${index}` })));
    expect(state.notices).toHaveLength(NOTICE_LIMIT);
    expect(state.notices.at(-1)?.message).toBe(`notice ${NOTICE_LIMIT + 4}`);
  });

  it("keeps the last lines of a running tool and drops them when it ends", () => {
    const many = Array.from({ length: TAIL_LINES + 3 }, (_, index) => `line ${index}`).join("\n");
    const running = reducePiEvent(initialPiNativeState(), { type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", partialResult: { content: [{ type: "text", text: many }] } });
    expect(running.toolTails["call_1"]).toHaveLength(TAIL_LINES);
    expect(running.toolTails["call_1"]?.at(-1)).toBe(`line ${TAIL_LINES + 2}`);

    const longLine = reducePiEvent(initialPiNativeState(), { type: "tool_execution_update", toolCallId: "call_2", toolName: "bash", partialResult: { content: [{ type: "text", text: "x".repeat(TAIL_LINE_CHARS + 100) }] } });
    expect(longLine.toolTails["call_2"]?.[0]).toHaveLength(TAIL_LINE_CHARS);

    expect(reducePiEvent(running, { type: "tool_execution_end", toolCallId: "call_1", isError: false }).toolTails).toEqual({});
  });

  it("extends a direct bash command's tail with each delta", () => {
    const state = reduced(initialPiNativeState(), [
      { type: "bash_execution_update", id: "req-9", delta: "first\nsec" },
      { type: "bash_execution_update", id: "req-9", delta: "ond\nthird\n" },
    ]);
    // the delta continues the line it split, and the empty last line is the output's own newline
    expect(state.toolTails["req-9"]).toEqual(["first", "second", "third", ""]);
  });

  it("is the same object when a record changes nothing", () => {
    const state = initialPiNativeState();
    expect(reducePiEvent(state, { type: "entry_appended", entry: {} })).toBe(state);
    expect(reducePiEvent(state, { type: "response", command: "set_model", success: false, error: "nope" })).toBe(state);
  });
});
