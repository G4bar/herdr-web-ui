import { describe, expect, test } from "bun:test";

import { askedQuestions, settledAsk } from "./askQuestions.ts";

describe("a past question tool call", () => {
  test("reads omp's ask, with its recommended option by index", () => {
    expect(askedQuestions("ask", {
      i: "Picking the install path",
      questions: [{ id: "path", header: "Install path", question: "Which one should stay?", recommended: 1, options: [
        { label: "Homebrew only", description: "Drop the curl script section" },
        { label: "Both", description: "Keep both" },
      ] }],
    })).toEqual([{ header: "Install path", question: "Which one should stay?", multi: false, recommended: 1, options: [
      { label: "Homebrew only", description: "Drop the curl script section", preview: null },
      { label: "Both", description: "Keep both", preview: null },
    ] }]);
  });

  test("reads OmO's and Claude's multiSelect, a preview, and a question without options", () => {
    for (const tool of ["ask_user_question", "request_user_input", "AskUserQuestion"]) {
      expect(askedQuestions(tool, { questions: [
        { header: "Symptoms", question: "What goes wrong?", multiSelect: true, options: [{ label: "Layout", preview: "┌─┐" }, { label: "Answer", description: "" }] },
        { header: "Notes", question: "Anything else?" },
      ] })).toEqual([
        { header: "Symptoms", question: "What goes wrong?", multi: true, recommended: null, options: [
          { label: "Layout", description: null, preview: "┌─┐" },
          { label: "Answer", description: null, preview: null },
        ] },
        { header: "Notes", question: "Anything else?", multi: false, recommended: null, options: [] },
      ]);
    }
  });

  test("ignores a recommendation that names no option", () => {
    for (const recommended of [2, -1, 0.5, "0"]) {
      expect(askedQuestions("ask", { questions: [{ question: "Q?", recommended, options: [{ label: "A" }, { label: "B" }] }] })?.[0]?.recommended).toBeNull();
    }
  });

  test("leaves other tools and shapes it does not know as their JSON", () => {
    expect(askedQuestions("Bash", { questions: [{ question: "Q?" }] })).toBeNull();
    for (const args of [null, "text", {}, { questions: [] }, { questions: "Q?" }, { questions: [null] }, { questions: [{ question: "" }] },
      { questions: [{ question: "Q?", header: 3 }] }, { questions: [{ question: "Q?", options: "A" }] },
      { questions: [{ question: "Q?", options: [{ label: "" }] }] }, { questions: [{ question: "Q?", options: [{ label: "A", description: 1 }] }] },
      { questions: [{ question: "Q?" }, { header: "no question" }] }]) {
      expect(askedQuestions("ask", args)).toBeNull();
    }
  });
});

describe("what pi recorded of the answer", () => {
  const asked = (multiSelect = false) => askedQuestions("ask_user_question", { questions: [
    { header: "Layout", question: "Which layout should the settings page use?", multiSelect, options: [
      { label: "Sidebar", preview: "+---+\n| a |" },
      { label: "Tabs", preview: "+-----------+\n| tab | tab |" },
    ] },
  ] })!;
  // sentences a real pi session records under an answered, a multi-picked and a skipped card
  const answered = 'User has answered your questions: "Which layout should the settings page use?"="Tabs". selected preview: +-----------+\n| tab | tab |. You can now continue with the user\'s answers in mind.';

  test("reads the picked option and the preview it showed", () => {
    const [question] = asked();
    expect(settledAsk(asked(), answered)).toEqual([
      { question: question!, picks: ["Tabs"], preview: "+-----------+\n| tab | tab |" },
    ]);
  });

  test("reads a multi answer as one pick per option", () => {
    const multi = askedQuestions("ask_user_question", { questions: [{ question: "Which?", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] }] })!;
    expect(settledAsk(multi, 'User has answered your questions: "Which?"="A, C". You can now continue with the user\'s answers in mind.')?.[0]?.picks).toEqual(["A", "C"]);
  });

  test("keeps a typed reply as the pick alone, with no preview", () => {
    expect(settledAsk(asked(), 'User has answered your questions: "Which layout should the settings page use?"="Something else". You can now continue with the user\'s answers in mind.')?.[0])
      .toEqual({ question: asked()[0]!, picks: ["Something else"], preview: null });
  });

  test("reads a skipped card as no answer", () => {
    expect(settledAsk(asked(), "User declined to answer questions")?.[0]?.picks).toEqual([]);
  });

  test("leaves another tool's answer alone", () => {
    expect(settledAsk(asked(), '{"answers":{"layout":"tabs"}}')).toBeNull();
    expect(settledAsk(asked(), "")).toBeNull();
  });
});
