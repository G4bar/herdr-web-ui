/**
 * What Pi loaded for a session (DS §4.10): the context files of the pane's folder, read by the
 * server (GET /api/pi/context, server/pi-context.ts), and the skills, prompt templates and
 * extension commands `get_commands` reports over RPC. Context files are not in RPC, and there is
 * no MCP status source, so the MCP tab the design lists is not offered.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchPiContext, sendPiRpc, type PiContextFile } from "./api.ts";

/** One entry of `get_commands`, cut to what the dialog and the greeting line say of it. */
export interface PiCommand {
  name: string;
  description: string;
  source: "skill" | "prompt" | "extension";
  /** where Pi found it: a resource's `user`/`project`/`temporary`, else how it was discovered */
  scope: string | null;
  /** the file or folder it was loaded from, when Pi names one */
  path: string | null;
}

/** An extension with the commands it registered: what the Extensions tab lists, read-only. */
export interface PiExtension {
  name: string;
  scope: string | null;
  commands: string[];
}

const text = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;
const fields = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

/** Pi's answer to `get_commands`, cut to the three kinds the dialog has a tab for. */
export function piCommands(data: unknown): PiCommand[] {
  const list = fields(data)["commands"];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const command = fields(entry);
    const name = text(command["name"]);
    const source = command["source"];
    if (name === null || (source !== "skill" && source !== "prompt" && source !== "extension")) return [];
    const info = fields(command["sourceInfo"]);
    return [{
      name,
      description: text(command["description"]) ?? "",
      source,
      scope: text(info["scope"]) ?? text(info["origin"]) ?? text(info["source"]),
      path: text(info["path"]),
    }];
  });
}

/** An extension's own name: the file or folder Pi loaded it from, else the command it registered. */
function extensionName(command: PiCommand): string {
  const path = command.path?.replace(/[\\/]+$/u, "") ?? "";
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return name.replace(/\.(?:ts|js|mjs|cjs)$/u, "") || command.name;
}

/** The commands of each tab, extensions gathered by the resource that registered them. */
export function piResources(commands: readonly PiCommand[]): { skills: PiCommand[]; prompts: PiCommand[]; extensions: PiExtension[] } {
  const extensions = new Map<string, PiExtension>();
  for (const command of commands) {
    if (command.source !== "extension") continue;
    const key = command.path ?? command.name;
    const found = extensions.get(key) ?? { name: extensionName(command), scope: command.scope, commands: [] };
    found.commands.push(command.name);
    extensions.set(key, found);
  }
  return {
    skills: commands.filter((command) => command.source === "skill"),
    prompts: commands.filter((command) => command.source === "prompt"),
    extensions: [...extensions.values()],
  };
}

/** What Use puts in the message box: Pi runs a command as `/name`, and a skill's name carries `skill:`. */
export function piCommandText(command: PiCommand): string {
  const name = command.source === "skill" && !command.name.startsWith("skill:") ? `skill:${command.name}` : command.name;
  return `/${name} `;
}

export interface PiResourcesRead {
  /** null until the first read answers */
  files: PiContextFile[] | null;
  /** null until the first read answers, and always for a Terminal-mode pane, which has no RPC */
  commands: PiCommand[] | null;
  /** a source refused: the dialog says so, and Try again reads both again */
  failed: boolean;
  /** read both sources again */
  read: () => void;
}

/**
 * What Pi loaded for `paneId`. A Terminal-mode pane has no RPC, so its commands are never asked
 * for; each source is read on its own, so one refusal does not throw the other's answer away.
 */
export function usePiResources(paneId: string, native: boolean, machineId = "local"): PiResourcesRead {
  const key = `${machineId}:${paneId}:${native}`;
  const [state, setState] = useState<{ key: string; files: PiContextFile[] | null; commands: PiCommand[] | null; failed: boolean }>({ key, files: null, commands: null, failed: false });
  const [tick, setTick] = useState(0);
  // another pane's answer is never drawn: a read of this one is still out
  const shown = state.key === key ? state : { key, files: null, commands: null, failed: false };
  useEffect(() => {
    let alive = true;
    const write = (change: { files?: PiContextFile[]; commands?: PiCommand[]; failed?: boolean }): void => {
      if (alive) setState((current) => ({ ...current, ...change, key }));
    };
    fetchPiContext(paneId, machineId).then((files) => write({ files }), () => write({ failed: true }));
    if (native) void sendPiRpc(paneId, { type: "get_commands" }, machineId).then((data) => write({ commands: piCommands(data) }), () => write({ failed: true }));
    return () => { alive = false; };
  }, [paneId, native, machineId, key, tick]);
  return { ...shown, read: useCallback(() => setTick((value) => value + 1), []) };
}
