import { afterEach, expect, it } from "bun:test";
import { initialPiNativeState } from "../../server/pi-rpc.ts";
import { clearedQueue, clearPiQueue, queuedTexts, PiNativeLanes, piNativeLanes, takeOverPi, handBackPi } from "./piNative.ts";

const native = (extra: Record<string, unknown> = {}) => ({ ...initialPiNativeState(), mode: "native" as const, ...extra });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; piNativeLanes.publish("t", null); piNativeLanes.askTrust("t", null); });

it("seeds a lane from the read and replaces it whole with each push", () => {
  const lanes = new PiNativeLanes();
  expect(lanes.get("local:p").state).toBeNull();
  lanes.seed("local:p", native({ isStreaming: false }));
  expect(lanes.get("local:p").state?.isStreaming).toBe(false);
  lanes.publish("local:p", { ...native(), isStreaming: true });
  expect(lanes.get("local:p").state?.isStreaming).toBe(true);
});

it("keeps a pushed state over a read that started before it", () => {
  const lanes = new PiNativeLanes();
  lanes.publish("local:p", native({ isStreaming: true }));
  lanes.seed("local:p", native({ isStreaming: false }));
  expect(lanes.get("local:p").state?.isStreaming).toBe(true);
  // a reconnect's pushes only carry changes: the next read lands again until one arrives
  lanes.reseed("local:p");
  lanes.seed("local:p", native({ isStreaming: false }));
  expect(lanes.get("local:p").state?.isStreaming).toBe(false);
});

it("reads a removed push as the hand-back it is", () => {
  const lanes = new PiNativeLanes();
  lanes.publish("local:p", native());
  lanes.publish("local:p", { ...native(), mode: "removed" });
  expect(lanes.get("local:p").state).toBeNull();
});

it("reads the lane again for a chat that was away while a removed push came", () => {
  const lanes = new PiNativeLanes();
  // the chat unmounts without hearing Pi's hand-back, so its last state would stand: the next mount's
  // read decides again (usePiNative reseeds on the way out and after a reconnect)
  lanes.publish("local:p", native());
  lanes.reseed("local:p");
  lanes.seed("local:p", null);
  expect(lanes.get("local:p").state).toBeNull();
});

it("keeps the trust question of a take-over until an answer, and tells subscribers of changes only", () => {
  const lanes = new PiNativeLanes();
  let changes = 0;
  const off = lanes.subscribe(() => { changes += 1; });
  lanes.askTrust("local:p", { folder: "/repo", found: ["AGENTS.md"], message: "Trust this project?" });
  lanes.askTrust("local:p", lanes.get("local:p").trust);
  expect(changes).toBe(1);
  off();
  lanes.askTrust("local:p", null);
  expect(changes).toBe(1);
  expect(lanes.get("local:p").trust).toBeNull();
});

it("publishes a take-over's needs_trust answer as the lane's question, and its state otherwise", async () => {
  globalThis.fetch = (async () => Response.json({ error: { code: "needs_trust", message: "Trust this project?" }, folder: "/repo", found: ["AGENTS.md", ".pi/settings.json"] }, { status: 409 })) as unknown as typeof fetch;
  const asked = await takeOverPi("t");
  expect(asked).toEqual({ needsTrust: { folder: "/repo", found: ["AGENTS.md", ".pi/settings.json"], message: "Trust this project?" } });
  expect(piNativeLanes.get("t").trust?.folder).toBe("/repo");

  globalThis.fetch = (async () => Response.json({ ...initialPiNativeState(), mode: "native" })) as unknown as typeof fetch;
  await takeOverPi("t", "local", "approve");
  expect(piNativeLanes.get("t").state?.mode).toBe("native");
  expect(piNativeLanes.get("t").trust).toBeNull();

  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
  await handBackPi("t");
  expect(piNativeLanes.get("t").state).toBeNull();
});

it("hands a native Stop's queue back in delivery order", () => {
  expect(clearedQueue({ steering: ["stop this"], followUp: ["then this", ""] })).toEqual(["stop this", "then this"]);
  expect(clearedQueue({})).toEqual([]);
  expect(clearedQueue(null)).toEqual([]);
});

it("takes Pi's queue out whole for Alt+Up, and reads a refused clear_queue as nothing held", async () => {
  const calls: string[] = [];
  const piRpc = async (command: { type: string }): Promise<unknown> => {
    calls.push(command.type);
    return { steering: ["steer me"], followUp: ["later"] };
  };
  const queue = await clearPiQueue(piRpc);
  expect(queuedTexts(queue)).toEqual(["steer me", "later"]);
  expect(calls).toEqual(["clear_queue"]);
  // a command the bridge refused answered nothing: the box stays as the user left it
  expect(await clearPiQueue(async () => null)).toEqual({ steering: [], followUp: [] });
  expect(clearedQueue({ steering: ["only steers"] })).toEqual(["only steers"]);
});
