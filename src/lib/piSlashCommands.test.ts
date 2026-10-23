import { describe, expect, it } from "bun:test";
import { piSlashSurface } from "./piSlashCommands.ts";

const kind = (text: string): string | null => piSlashSurface(text)?.kind ?? null;

describe("piSlashSurface", () => {
  it("reads each command the chat has a surface for", () => {
    expect(kind("/model")).toBe("model");
    expect(kind("/new")).toBe("new");
    expect(kind("/session")).toBe("session");
    expect(kind("/export")).toBe("export");
    expect(kind("/copy")).toBe("copy");
    expect(kind("/hotkeys")).toBe("hotkeys");
    expect(kind("/context")).toBe("context");
  });

  it("takes the argument a command is defined to take", () => {
    expect(piSlashSurface("/name my feature")).toEqual({ kind: "name", name: "my feature" });
    expect(piSlashSurface("/compact")).toEqual({ kind: "compact", instructions: null });
    expect(piSlashSurface("/compact keep the migration")).toEqual({ kind: "compact", instructions: "keep the migration" });
  });

  it("leaves an argument the surface cannot honour, and a bare /name, to the message", () => {
    expect(kind("/name")).toBeNull();
    expect(kind("/model sonnet")).toBeNull();
    expect(kind("/export /tmp/session.html")).toBeNull();
  });

  it("is not a command: prose, a path, a second line, or a name Pi does not own", () => {
    expect(kind("explain /model")).toBeNull();
    expect(kind("/tmp/file.txt")).toBeNull();
    expect(kind("/model\nand then explain it")).toBeNull();
    expect(kind("/resume")).toBeNull();
    expect(kind("/tree")).toBeNull();
    // built into Pi's TUI: `prompt` would only hand it to the model as a message (docs/rpc-commands.md)
    expect(kind("/reload")).toBeNull();
    expect(kind("")).toBeNull();
  });

  it("ignores case and the spaces around the command", () => {
    expect(kind("  /Model  ")).toBe("model");
    expect(kind("/NAME  spaced name ")).toBe("name");
    expect(piSlashSurface("/name  spaced name ")).toEqual({ kind: "name", name: "spaced name" });
  });
});
