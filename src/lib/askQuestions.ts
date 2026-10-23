/**
 * The questions an agent asked the user with its question tool, read from the call's recorded
 * arguments: omp's `ask`, OmO's `ask_user_question` (`request_user_input` under a Codex model) and
 * Claude Code's `AskUserQuestion`. The chat shows a past call as the questions and options it
 * offered instead of their JSON; it is a record, never another way to answer.
 */

export interface AskedOption {
  label: string;
  description: string | null;
  /** what the option would look like (Claude's and omp's `preview`), shown as written */
  preview: string | null;
}

export interface AskedQuestion {
  header: string | null;
  question: string;
  /** more than one option may be picked */
  multi: boolean;
  /** omp's recommended option, by its index */
  recommended: number | null;
  /** none: the question takes a typed answer */
  options: AskedOption[];
}

/** What an answer put to one asked question: the option labels (or the typed reply) that were picked. */
export interface AskedAnswer {
  question: AskedQuestion;
  /** one per picked option, or the single thing the user typed; empty when nothing was answered */
  picks: string[];
  /** the preview the picked option showed, as the call recorded it */
  preview: string | null;
}

const ASK_TOOLS: ReadonlySet<string> = new Set(["ask", "ask_user_question", "request_user_input", "AskUserQuestion"]);

const optionalText = (value: unknown): value is string | null | undefined => value == null || typeof value === "string";

/** A question tool's questions, or null for another tool or arguments not in a shape it asks with. */
export function askedQuestions(tool: string, args: unknown): AskedQuestion[] | null {
  if (!ASK_TOOLS.has(tool) || args === null || typeof args !== "object") return null;
  const questions = (args as Record<string, unknown>)["questions"];
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const asked: AskedQuestion[] = [];
  for (const value of questions) {
    if (value === null || typeof value !== "object") return null;
    const question = value as Record<string, unknown>;
    if (typeof question["question"] !== "string" || !question["question"].trim() || !optionalText(question["header"])) return null;
    const rawOptions = question["options"] ?? [];
    if (!Array.isArray(rawOptions)) return null;
    const options: AskedOption[] = [];
    for (const item of rawOptions) {
      if (item === null || typeof item !== "object") return null;
      const option = item as Record<string, unknown>;
      if (typeof option["label"] !== "string" || !option["label"].trim() || !optionalText(option["description"]) || !optionalText(option["preview"])) return null;
      options.push({ label: option["label"], description: option["description"] || null, preview: option["preview"] || null });
    }
    const recommended = question["recommended"];
    asked.push({
      header: question["header"] || null,
      question: question["question"],
      multi: question["multi"] === true || question["multiSelect"] === true,
      recommended: Number.isInteger(recommended) && (recommended as number) >= 0 && (recommended as number) < options.length ? recommended as number : null,
      options,
    });
  }
  return asked;
}

/**
 * What pi recorded once its questions were answered: `User has answered your questions:
 * "<question>"="<answer>"`, then what the picked option previewed and pi's closing sentence; a
 * skipped card says `User declined to answer questions`. Null for any other tool's answer, which
 * keeps the call's own rendering: this reads pi's sentence alone.
 */
export function settledAsk(questions: AskedQuestion[], output: string): AskedAnswer[] | null {
  const declined = /^User declined to answer questions\b/.test(output.trim());
  const prefix = "User has answered your questions: ";
  if (!declined && !output.trim().startsWith(prefix)) return null;
  const rest = declined ? "" : output.trim().slice(prefix.length)
    .replace(/\. selected preview: [\s\S]*$/, "")
    .replace(/\. You can now continue[\s\S]*$/, "");
  return questions.map((question) => {
    const at = rest.indexOf(`"${question.question}"="`);
    if (at < 0) return { question, picks: [], preview: null };
    const start = at + `"${question.question}"="`.length;
    // the answer ends at the last quote before the next question's own quoted text
    const next = rest.slice(start).search(/", "/);
    const chunk = next < 0 ? rest.slice(start) : rest.slice(start, start + next);
    const answer = chunk.replace(/"$/, "");
    const picks = question.multi ? answer.split(", ").map((pick) => pick.trim()).filter((pick) => pick.length > 0) : [answer];
    const option = picks.length === 1 ? question.options.find((choice) => choice.label === picks[0]) : undefined;
    return { question, picks, preview: option?.preview ?? null };
  });
}
