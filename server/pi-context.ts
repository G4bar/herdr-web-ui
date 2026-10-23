/**
 * What Pi loads as a session's context: the instruction files of its agent directory and of the
 * working directory up to the filesystem root. Pi's rule (its `docs/configuration.md`): one file
 * per directory, the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`,
 * `CLAUDE.MD`, and the agent directory's file first, then the root's down to the working
 * directory's. Only names and sizes are read here; the FileViewer opens a file's contents.
 *
 * shortcut: Pi also skips the main repository's file that a linked worktree's own copy shadows;
 * this list may name both.
 */
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { piAgentDir } from "./pi-models.ts";

/** `global` is the agent directory's file, `project` the working directory's, `parent` any above it. */
export type PiContextScope = "global" | "project" | "parent";

export interface PiContextFile {
  path: string;
  scope: PiContextScope;
  size: number;
}

const NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/** The one context file Pi would take from `dir`, or null when it holds none. */
function contextFileIn(dir: string): { path: string; size: number } | null {
  for (const name of NAMES) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      // a directory named like one is no context file; Pi tries the next name
      if (stat.isFile()) return { path, size: stat.size };
    } catch { /* absent or unreadable: Pi tries the next name too */ }
  }
  return null;
}

/** Pi's context chain for `cwd`, in Pi's own order and with no file twice. */
export function piContextFiles(cwd: string, agentDir = piAgentDir()): PiContextFile[] {
  const working = resolve(cwd);
  const files: PiContextFile[] = [];
  const seen = new Set<string>();
  const global = contextFileIn(resolve(agentDir));
  if (global !== null) {
    files.push({ ...global, scope: "global" });
    seen.add(global.path);
  }
  // Pi collects the ancestors walking up and unshifts each: the root's file comes before the deeper ones
  const ancestors: PiContextFile[] = [];
  let dir = working;
  while (true) {
    const found = contextFileIn(dir);
    if (found !== null && !seen.has(found.path)) {
      ancestors.unshift({ ...found, scope: dir === working ? "project" : "parent" });
      seen.add(found.path);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  files.push(...ancestors);
  return files;
}
