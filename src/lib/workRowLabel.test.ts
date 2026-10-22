import { describe, expect, it } from "bun:test";
import { workRowLabel } from "./workRowLabel.ts";

describe("workRowLabel", () => {
  it("shows an agent's own sentence alone while keeping the existing verb decision for details", () => {
    expect(workRowLabel({ name: "eval", input: '{"summary":"Run the checks","code":"check()"}' }, "Run the checks")).toEqual({ narration: true, verb: null, object: "Run the checks" });
    expect(workRowLabel({ name: "Bash", input: '{"description":"Check ports","command":"lsof -i"}' }, "Check ports")).toEqual({ narration: true, verb: null, object: "Check ports" });
  });

  it("retains verbs and tool names for non-narration summaries", () => {
    expect(workRowLabel({ name: "Read", input: '{"file_path":"src/a.ts"}' }, "src/a.ts")).toEqual({ narration: false, verb: "Read", object: "src/a.ts" });
    expect(workRowLabel({ name: "lookup", input: "{}" }, "lookup")).toEqual({ narration: false, verb: null, object: "lookup" });
    expect(workRowLabel({ name: "eval", input: "{" }, "Run the checks")).toEqual({ narration: false, verb: null, object: "Run the checks" });
  });

  it("names an MCP call by the tool it ran, with its server for the opened card", () => {
    expect(workRowLabel({ name: "mcp__github__create_issue", input: '{"title":"x"}' }, "mcp__github__create_issue"))
      .toEqual({ narration: false, verb: "Called", object: "create_issue", server: "github" });
  });
});
