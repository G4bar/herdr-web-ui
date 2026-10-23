import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { PiNativeState } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { ApiError, handBackPiPane, reconnectPiPane, takeOverPiPane, type PiRpcCommand, type PiTakeover, type PiTrustRequest } from "./api.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";
import { useMachineSessions } from "./machineSessionContext.tsx";

/**
 * One pane's Pi lane: the live state the bridge pushes while the chat drives Pi over RPC, and the
 * folder trust question a take-over answered with. A null state is a Terminal-mode pane (or none):
 * the chat then reads the transcript exactly as it always did.
 */
export interface PiNativeLane {
  state: PiNativeState | null;
  trust: PiTrustRequest | null;
  /** a take-over, hand-back or reconnect the pane refused, in the server's own sentence: nothing changed */
  failure: string | null;
}

const NO_LANE: PiNativeLane = { state: null, trust: null, failure: null };

/** `removed` is the last state a watcher is sent: Pi is the terminal's again, so the chat holds none. */
const held = (state: PiNativeState | null): PiNativeState | null => state === null || state.mode === "removed" ? null : state;

/**
 * The Pi lanes of the panes this page has read, keyed `<machine>:<pane>` (`paneStorageId`) and shared
 * by the pane's chat and the header's menu: neither owns the state, the bridge's pushes do. A lane
 * keeps its object until it changes, so a reader re-renders only for its own lane.
 */
export class PiNativeLanes {
  private readonly lanes = new Map<string, PiNativeLane>();
  /** Lanes a push has reached since the last reconnect: a read that started earlier is older news. */
  private readonly pushed = new Set<string>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get(key: string): PiNativeLane { return this.lanes.get(key) ?? NO_LANE; }

  /** A push, or a route's own answer: the state replaces the lane's whole, and `removed` clears it. */
  publish(key: string, state: PiNativeState | null): void {
    this.pushed.add(key);
    this.write(key, { ...this.get(key), state: held(state) });
  }

  /** `GET /api/pi/state`, read before the first push of a connection: a push that arrived meanwhile wins. */
  seed(key: string, state: PiNativeState | null): void {
    if (this.pushed.has(key)) return;
    this.write(key, { ...this.get(key), state: held(state) });
  }

  /** A reconnect's pushes carry only changes: the next read fills the lane again until one lands. */
  reseed(key: string): void { this.pushed.delete(key); }

  /** The trust question a take-over stopped at, or null once it is answered or refused. */
  askTrust(key: string, request: PiTrustRequest | null): void {
    this.write(key, { ...this.get(key), trust: request });
  }

  /** The sentence of an action the pane refused; the pane's notices carry it until it is put away. */
  fail(key: string, message: string | null): void {
    this.write(key, { ...this.get(key), failure: message });
  }

  private write(key: string, lane: PiNativeLane): void {
    const before = this.get(key);
    if (before.state === lane.state && before.trust === lane.trust && before.failure === lane.failure) return;
    this.lanes.set(key, lane);
    for (const listener of this.listeners) listener();
  }
}

export const piNativeLanes = new PiNativeLanes();

/** The server's sentence for a refused action: what the pane said, not the URL and status around it. */
const refusal = (error: unknown): string => error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error);

/** POST /api/pi/takeover: Pi's state lands in the lane, or the trust question its folder raised does. */
export async function takeOverPi(paneId: string, machineId = "local", trust?: "approve" | "deny"): Promise<PiTakeover> {
  const key = paneStorageId(machineId, paneId);
  try {
    const answer = await takeOverPiPane(paneId, trust, machineId);
    if ("needsTrust" in answer) piNativeLanes.askTrust(key, answer.needsTrust);
    else {
      piNativeLanes.askTrust(key, null);
      piNativeLanes.publish(key, answer.state);
    }
    piNativeLanes.fail(key, null);
    return answer;
  } catch (error) {
    // busy, a TUI that would not quit: the pane is as it was, and its own sentence says why
    piNativeLanes.fail(key, refusal(error));
    throw error;
  }
}

/** POST /api/pi/handback: Pi is the terminal's again, so the lane holds no state of the chat's. */
export async function handBackPi(paneId: string, machineId = "local"): Promise<void> {
  const key = paneStorageId(machineId, paneId);
  try {
    await handBackPiPane(paneId, machineId);
    piNativeLanes.publish(key, null);
    piNativeLanes.fail(key, null);
  } catch (error) {
    piNativeLanes.fail(key, refusal(error));
    throw error;
  }
}

/** POST /api/pi/reconnect: the lost child started again on the session it held. */
export async function reconnectPi(paneId: string, machineId = "local"): Promise<PiNativeState> {
  const key = paneStorageId(machineId, paneId);
  try {
    const state = await reconnectPiPane(paneId, machineId);
    piNativeLanes.publish(key, state);
    piNativeLanes.fail(key, null);
    return state;
  } catch (error) {
    piNativeLanes.fail(key, refusal(error));
    throw error;
  }
}

/** How Pi holds a message sent while a turn runs: a steer lands mid-turn, a follow-up after it (DS §3.2). */
export type PiDeliver = "steer" | "followUp";

/** A native pane's held messages by kind, as `clear_queue` answered with them. */
export interface PiQueue { steering: string[]; followUp: string[] }

/** `clear_queue`'s answer as a queue: anything else (`null` on a refused command) holds nothing. */
function asQueue(cleared: unknown): PiQueue {
  const queue = cleared as { steering?: unknown; followUp?: unknown } | null;
  const texts = (values: unknown): string[] => Array.isArray(values) ? values.filter((value): value is string => typeof value === "string" && value !== "") : [];
  return queue === null || typeof queue !== "object" ? { steering: [], followUp: [] } : { steering: texts(queue.steering), followUp: texts(queue.followUp) };
}

/** A queue's texts in delivery order: steers first, then follow-ups (DS §4.4). */
export function queuedTexts(queue: PiQueue): string[] {
  return [...queue.steering, ...queue.followUp];
}

/** The queued messages a native Stop took back out of Pi's queue (`clear_queue`), in delivery order. */
export function clearedQueue(cleared: unknown): string[] {
  return queuedTexts(asQueue(cleared));
}

/** Pi's queue taken out whole (`clear_queue`): its answer, not the pushed state, is what goes back in. */
export async function clearPiQueue(piRpc: (command: PiRpcCommand) => Promise<unknown>): Promise<PiQueue> {
  return asQueue(await piRpc({ type: "clear_queue" }));
}

export interface PiNativeHandle {
  /** null: this pane is not driven over RPC (Terminal mode): the chat behaves as it always did */
  state: PiNativeState | null;
  /** the folder Pi waits on, until its card's trust question is answered: `TrustCard` asks it in the prompt dock */
  trustRequest: PiTrustRequest | null;
  /** an action the pane refused, in the server's own words; nothing in the pane changed */
  failure: string | null;
  /** one allowlisted command for the pane's Pi; a refusal throws ApiError with Pi's own sentence */
  piRpc: (command: PiRpcCommand) => Promise<unknown>;
  takeOver: (trust?: "approve" | "deny") => Promise<PiTakeover>;
  handBack: () => Promise<void>;
  reconnect: () => Promise<PiNativeState>;
}

/** The lane of `key`, as React reads it: the same object until something writes it. */
function useLane(key: string | null): PiNativeLane {
  return useSyncExternalStore(piNativeLanes.subscribe, () => key === null ? NO_LANE : piNativeLanes.get(key), () => NO_LANE);
}

/** A lane without a socket of its own (App's More menu): the pane's chat is what seeds and listens. */
export function usePiNativeLane(machineId: string, paneId: string | null): PiNativeLane {
  return useLane(paneId === null ? null : paneStorageId(machineId, paneId));
}

/**
 * One pane's Pi lane, kept live: seeded from `GET /api/pi/state` (again after a reconnect, before its
 * replay) and replaced whole by every `pi-native-state` push the bridge sends this client.
 */
export function usePiNative(paneId: string | null): PiNativeHandle {
  const machineId = useMachineId();
  const api = useMachineApi();
  const sessions = useMachineSessions();
  const key = paneId === null ? null : paneStorageId(machineId, paneId);
  const lane = useLane(key);

  useEffect(() => {
    if (paneId === null || key === null) return;
    let current = true;
    const seed = (): void => {
      void api.fetchPiNativeState(paneId).then((state) => { if (current) piNativeLanes.seed(key, state); }, () => undefined);
    };
    const socket = sessions?.get(machineId).socket ?? null;
    const offPush = socket?.onPiNativeState(paneId, (state) => piNativeLanes.publish(key, state)) ?? (() => {});
    const offReplay = socket?.onBeforeReplay(() => { piNativeLanes.reseed(key); seed(); }) ?? (() => {});
    seed();
    return () => {
      current = false;
      offPush();
      offReplay();
      // This chat is what hears the pushes, so a frame that came while it was away (a `removed`) is
      // lost: the next mount reads the lane again instead of trusting the state it left.
      piNativeLanes.reseed(key);
    };
  }, [api, paneId, key, machineId, sessions]);

  const piRpc = useCallback((command: PiRpcCommand): Promise<unknown> => paneId === null
    ? Promise.reject(new Error("this pane has no Pi to command"))
    : api.sendPiRpc(paneId, command), [api, paneId]);
  const takeOver = useCallback((trust?: "approve" | "deny"): Promise<PiTakeover> => paneId === null
    ? Promise.reject(new Error("this pane has no Pi to take over"))
    : takeOverPi(paneId, machineId, trust), [paneId, machineId]);
  const handBack = useCallback((): Promise<void> => paneId === null ? Promise.resolve() : handBackPi(paneId, machineId), [paneId, machineId]);
  const reconnect = useCallback((): Promise<PiNativeState> => paneId === null
    ? Promise.reject(new Error("this pane has no Pi to reconnect"))
    : reconnectPi(paneId, machineId), [paneId, machineId]);

  return { state: lane.state, trustRequest: lane.trust, failure: lane.failure, piRpc, takeOver, handBack, reconnect };
}
