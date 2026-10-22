import { describe, expect, it } from "bun:test";

import { isToolNarration, mcpTarget, toolCallLabel, toolVerb, toolVerbKind } from "./toolVerbs.ts";

describe("toolVerbKind", () => {
  it("reads every agent's file and shell tools as one of four verbs", () => {
    const expected: Record<string, string> = {
      // Claude Code
      Read: "read", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", Write: "write", Bash: "run",
      // Codex
      exec: "run", exec_command: "run", shell: "run", shell_command: "run", local_shell: "run", apply_patch: "edit",
      // pi, omp, gjc and omo name theirs in lowercase
      read: "read", edit: "edit", multiedit: "edit", patch: "edit", write: "write", bash: "run",
    };
    for (const [name, kind] of Object.entries(expected)) expect([name, toolVerbKind(name)]).toEqual([name, kind as ReturnType<typeof toolVerbKind>]);
  });

  it("reads Pi's search, todo, question, script, web and delegation tools as their own verbs", () => {
    const expected: Record<string, string> = {
      grep: "searched", Grep: "searched", find: "found", Find: "found", ls: "listed", LS: "listed",
      todo: "todo", ask_user_question: "asked", codemode: "script", tool_search: "toolSearch",
      web_search: "webSearch", fetch_content: "fetched",
      delegate_agent: "delegated", continue_agent: "delegated",
      steer_agent: "steered", interrupt_agent: "interrupted", reply_agent: "replied", close_agent: "closed",
      list_agents: "listedAgents", ask_owner: "askedOwner",
      // any MCP tool is one verb: its own name says which tool ran and on which server
      mcp__github__create_issue: "called", mcp__files__read_all: "called", mcp__omo__todo: "called",
    };
    for (const [name, kind] of Object.entries(expected)) expect([name, toolVerbKind(name)]).toEqual([name, kind as ReturnType<typeof toolVerbKind>]);
  });

  it("leaves every other tool the chat knows under its own name", () => {
    const untouched = [
      // counted as a file read or a command in the header, but not a plain read or run
      "Glob", "glob", "list", "search", "eval", "run_command",
      // tools with their own row or panel
      "Skill", "Task", "Agent", "task", "WebFetch", "WebSearch", "webfetch",
      "TodoWrite", "update_plan", "todo_write",
      "create_goal", "update_goal", "get_goal", "request_user_input_async",
      // a name that only contains a known one, and an MCP-shaped name that is not one
      "read_mcp_resource", "BashOutput", "write_stdin", "tool", "mcp__github",
    ];
    for (const name of untouched) expect([name, toolVerbKind(name)]).toEqual([name, null]);
  });

  it("calls a Codex exec that applies a patch an edit", () => {
    const script = 'const r = await tools.apply_patch("*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-a\\n+b\\n*** End Patch");';
    expect(toolVerbKind("exec", script)).toBe("edit");
    expect(toolVerbKind("exec", '{"cmd":"bun test"}')).toBe("run");
    // only a shell tool is re-read this way
    expect(toolVerbKind("Read", "*** Begin Patch\n*** End Patch")).toBe("read");
    expect(toolVerbKind("lookup", "*** Begin Patch\n*** End Patch")).toBeNull();
  });
});

describe("toolVerb", () => {
  const part = (name: string, args: Record<string, unknown> = {}) => ({ name, input: JSON.stringify(args, null, 2) });

  it("is the verb a row shows before its object", () => {
    expect(toolVerb(part("Read", { file_path: "src/metrics.ts" }), "src/metrics.ts")).toBe("Read");
    expect(toolVerb(part("read", { path: "src/metrics.ts" }), "src/metrics.ts")).toBe("Read");
    expect(toolVerb(part("Edit", { file_path: "src/pages/Reports.tsx", old_string: "a", new_string: "b" }), "src/pages/Reports.tsx")).toBe("Edited");
    expect(toolVerb(part("Write", { file_path: "notes.md", content: "x" }), "notes.md")).toBe("Wrote");
    expect(toolVerb(part("exec", { cmd: "pnpm test" }), "pnpm test")).toBe("Ran");
    expect(toolVerb(part("bash", { command: "pnpm test" }), "pnpm test")).toBe("Ran");
  });

  it("names the files of a patch, bare or inside an exec script", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+c\n*** End Patch";
    expect(toolVerb({ name: "apply_patch", input: patch }, "src/a.ts, src/b.ts")).toBe("Edited");
    expect(toolVerb({ name: "exec", input: `await tools.apply_patch(${JSON.stringify(patch)});` }, "src/a.ts, src/b.ts")).toBe("Edited");
    expect(toolVerb({ name: "exec", input: `await tools.apply_patch(${JSON.stringify(patch)});` }, "Fixing the typo")).toBeNull();
  });

  it("follows the server's cut of a long command", () => {
    const command = `echo ${"x".repeat(200)}`;
    expect(toolVerb(part("Bash", { command }), command.slice(0, 120))).toBe("Ran");
    expect(toolVerb(part("Bash", { command }), command.slice(0, 60))).toBeNull();
  });

  it("keeps the tool id when the summary is the call's intent, not its command or path", () => {
    // omp sums a call up by its intent: server/transcript-records.ts
    expect(toolVerb(part("bash", { command: "ss -tlnp" }), "Checking ports")).toBeNull();
    expect(toolVerb(part("read", { path: "config.toml" }), "Looking at the config")).toBeNull();
    expect(toolVerb(part("edit", { path: "README.md", old_text: "teh", new_text: "the" }), "Fixing the typo")).toBeNull();
    expect(toolVerb(part("write", { path: "notes.md", content: "x" }), "Saving the notes")).toBeNull();
    // the same calls without an intent are summed up by the command or path
    expect(toolVerb(part("bash", { command: "ss -tlnp" }), "ss -tlnp")).toBe("Ran");
    // a Claude Bash call is summed up by its command, never its description
    expect(toolVerb(part("Bash", { command: "ss -tlnp", description: "Check ports" }), "Check ports")).toBeNull();
    // a path is not what a command ran, nor a command what a file call read
    expect(toolVerb(part("bash", { path: "src/a.ts" }), "src/a.ts")).toBeNull();
    expect(toolVerb(part("read", { command: "cat a" }), "cat a")).toBeNull();
  });

  it("keeps the tool id when there is nothing to put after the verb", () => {
    expect(toolVerb(part("Bash"), "")).toBeNull();
    expect(toolVerb(part("bash", { command: "   " }), "   ")).toBeNull();
    // a call with no command or path is summed up by its own name
    expect(toolVerb(part("Bash"), "Bash")).toBeNull();
    // input that is not JSON and not a patch
    expect(toolVerb({ name: "exec", input: "console.log(1)" }, "console.log(1)")).toBeNull();
    expect(toolVerb({ name: "exec", input: "null" }, "null")).toBeNull();
  });

  it("keeps the id of a tool it does not know", () => {
    expect(toolVerb(part("Glob", { pattern: "TODO" }), "TODO")).toBeNull();
    expect(toolVerb(part("mcp__github", { path: "Fix the chart" }), "Fix the chart")).toBeNull();
  });

  it("reads Pi's own tools as their verb and object", () => {
    expect(toolVerb(part("grep", { pattern: "TODO" }), "TODO")).toBe("Searched");
    expect(toolVerb(part("find", { path: "src" }), "src")).toBe("Found");
    expect(toolVerb(part("ls", { path: "src/lib" }), "src/lib")).toBe("Listed");
    expect(toolVerb(part("todo", { todos: [{ status: "completed" }] }), "3/7 done")).toBe("Updated todos");
    expect(toolVerb(part("codemode", { code: "1", summary: "Map the chat" }), "Map the chat")).toBe("Ran script");
    expect(toolVerb(part("tool_search", { query: "spawn" }), "spawn")).toBe("Searched tools");
    expect(toolVerb(part("web_search", { query: "pi rpc" }), "pi rpc")).toBe("Searched the web");
    expect(toolVerb(part("fetch_content", { url: "https://example.com/a" }), "https://example.com/a")).toBe("Fetched");
    expect(toolVerb(part("delegate_agent", { label: "scout_ui" }), "scout_ui")).toBe("Delegated");
    expect(toolVerb(part("list_agents"), "3 agents")).toBe("Listed agents");
    expect(toolVerb(part("ask_owner", { question: "Ship it?" }), "Ship it?")).toBe("Asked owner");
    // a todo row whose summary is still the id has no object to put after the verb
    expect(toolVerb(part("todo"), "todo")).toBeNull();
  });

  it("asks the first question's header in front of the verb", () => {
    const asked = part("ask_user_question", { questions: [{ header: "Database", question: "Which database?", options: [] }] });
    expect(toolVerb(asked, "ask_user_question")).toBe("Asked");
    expect(toolCallLabel(asked, "ask_user_question")?.object).toBe("Database");
    const unheadered = part("ask_user_question", { questions: [{ question: "Which database?", options: [] }] });
    expect(toolCallLabel(unheadered, "ask_user_question")?.object).toBe("Which database?");
    // arguments that are not questions keep the id
    expect(toolVerb(part("ask_user_question", { questions: "x" }), "ask_user_question")).toBeNull();
  });

  it("names an MCP call by its tool, and keeps its server for the card", () => {
    const call = toolCallLabel(part("mcp__github__create_issue", { title: "x" }), "mcp__github__create_issue");
    expect(call).toEqual({ verb: "Called", object: "create_issue", server: "github" });
    // a tool name with the separator in it keeps both parts after the server
    expect(mcpTarget("mcp__linear__team__issues")).toEqual({ server: "linear", tool: "team__issues" });
    expect(mcpTarget("mcp__github")).toBeNull();
  });

  it("gives a ranged read the lines it covers", () => {
    expect(toolCallLabel(part("read", { path: "src/a.ts", offset: 120, limit: 61 }), "src/a.ts")).toEqual({ verb: "Read", object: "src/a.ts 120–180" });
    // a limit alone starts at the first line; an offset alone has no last line yet
    expect(toolCallLabel(part("read", { path: "src/a.ts", limit: 10 }), "src/a.ts")?.object).toBe("src/a.ts 1–10");
    expect(toolCallLabel(part("read", { path: "src/a.ts", offset: 120 }), "src/a.ts")?.object).toBe("src/a.ts 120–");
    expect(toolCallLabel(part("read", { path: "src/a.ts" }), "src/a.ts")?.object).toBe("src/a.ts");
  });
});

describe("isToolNarration", () => {
  const part = (name: string, input: unknown) => ({ name, input: JSON.stringify(input) });

  it("knows the agent's own sentence about a call from its command or path", () => {
    expect(isToolNarration(part("eval", { code: "await check()", summary: "Run the checks" }), "Run the checks")).toBe(true);
    expect(isToolNarration(part("Bash", { command: "bun test", description: " Run the unit tests " }), "Run the unit tests")).toBe(true);
    expect(isToolNarration(part("bash", { command: "lsof -i", intent: "Checking ports" }), "Checking ports")).toBe(true);
    // the server cuts the sentence, so the cut one still matches
    expect(isToolNarration(part("eval", { code: "1", summary: "x".repeat(200) }), "x".repeat(120))).toBe(true);
    expect(isToolNarration(part("Bash", { command: "bun test", description: "Run the unit tests" }), "bun test")).toBe(false);
    expect(isToolNarration(part("Read", { file_path: "src/a.ts" }), "src/a.ts")).toBe(false);
    expect(isToolNarration(part("eval", { code: "1" }), "eval")).toBe(false);
    expect(isToolNarration({ name: "exec", input: "console.log(1)" }, "console.log(1)")).toBe(false);
  });
});
