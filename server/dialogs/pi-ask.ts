import type { InteractivePromptAnswer } from "../../shared/protocol.ts";
import type { DialogReader } from "./registry.ts";
import { ANSI_RE, type AnswerStep, KEY, type OmoAsk, type ParsedPrompt, findLastIndex, finishPrompt, isDivider, keySteps, navigationKeys, wrapped } from "./shared.ts";
import { comparable } from "./omo.ts";
/** Argument text has no ceiling of its own: bound what the card shows, and so what its id names. */
export const PI_ASK_HEADER_CAP = 200;
export const PI_ASK_PREVIEW_CAP = 8_000;

export function capped(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The questionnaire `@juicesharp/rpiv-ask-user-question` draws for pi's `ask_user_question`
 * tool (2.13.9, `view/dialog-builder.ts`): a rule, the tab bar once it asks more than one
 * question, the heading, one numbered row per option, a rule, and its own `·`-joined hint. pi
 * draws it in its editor slot, so the hint never ends the screen: pi's folder line and context
 * meter stay under it. Nothing else there says `Enter to select · ↑/↓ to navigate`, and pi's
 * own dialogs and `/model` say their hints in other words.
 *
 *   ────────────────────────────────────────────────
 *    ←  □ Runtime   □ Storage   ✓ Submit  →
 *
 *    Runtime
 *
 *   Which runtime should the worker use?
 *
 *   ❯ 1. Bun
 *        Fast startup, built-in bundler.
 *     2. Node 22
 *        LTS, widest ecosystem support.
 *     3. Type something.
 *
 *   ────────────────────────────────────────────────
 *
 *    Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel
 */
export const RPIV_ASK_HINT_RE = /enter to select\s*·\s*↑\/↓ to navigate/i;
export const RPIV_ASK_HINT_AT_END_RE = new RegExp(`${RPIV_ASK_HINT_RE.source}.*$`, "i");
/**
 * pi's footer under the dialog: its folder, then its context meter, which a phone wraps onto a
 * second line. Measured on the 120- and 80-column captures: the hint sits one to two lines above
 * the bottom, and up to three blank lines can follow it on a multi-question tab.
 */
export const RPIV_ASK_FOOTER_LINES = 4;
/** the row rpiv adds under the options, numbered last: it takes text instead of a choice */
const RPIV_ASK_OTHER_LABEL = "Type something.";
/** `OVIS_PI_ASK_PROMPT=0`: the questionnaire stays plain terminal text, as before this reader */
export const RPIV_ASK_PROMPT = process.env.OVIS_PI_ASK_PROMPT !== "0";

type RpivRow = { number: number; label: string; description: string | null; cursor: boolean; boxed: boolean; checked: boolean };

/**
 * The dialog's own lines, with the preview box taken out: from 100 columns rpiv sets it beside
 * the list, below it under that. Its text is phase 6's, and its columns would otherwise read as
 * option labels.
 */
function rpivBody(lines: string[]): string[] {
  const column = lines.reduce((at, line) => {
    const found = line.indexOf("┌");
    return found > 0 && (at < 0 || found < at) ? found : at;
  }, -1);
  if (column > 0) return lines.map((line) => line.slice(0, column));
  return lines.filter((line) => !/^[┌│└]/.test(line.trim()) && !/^notes:/i.test(line.trim()));
}

/** The tab bar's tabs, in order: `□` a question still to answer, `■` one already answered, `✓` the Submit tab. */
function rpivTabs(line: string): { label: string; answered: boolean; submit: boolean }[] {
  return line.split(/(?=[□■✓])/).flatMap((part) => {
    const mark = part[0];
    const label = part.slice(1).replace(/[←→]/g, "").trim();
    if (!label || (mark !== "□" && mark !== "■" && mark !== "✓")) return [];
    return [{ label, answered: mark === "■", submit: mark === "✓" }];
  });
}

/**
 * The numbered rows, each with the lines under it joined back into its description, and the bare
 * lines after the last row (a multiple choice's `Submit`). A tick rpiv leaves on a single
 * select's confirmed row, and the checkbox in front of a multiple choice's rows, come off the
 * label.
 *
 * A row is `number.` and a space, its number continuing the one above, and it starts where the
 * first row's number starts: an option description that opens with a number (`3.5x smaller`,
 * `4. paths`) is not one, whether it has no space after the dot, or it sits in the description
 * column. A multiple choice's rows also carry rpiv's box, so a boxed list asks for that too — a
 * description reading `2. [ ] bar` under the row it describes is only told apart by the number.
 */
function rpivRows(lines: string[]): { rows: RpivRow[]; last: { label: string; cursor: boolean } | null } {
  const rows: RpivRow[] = [];
  let last: { label: string; cursor: boolean } | null = null;
  let column = -1;
  let boxed = false;
  const kept: { text: string; column: number }[] = [];
  for (const raw of lines) {
    const text = raw.trim();
    if (!text || isDivider(text) || /^[↑↓↕]$/.test(text) || /^\(\d+\/\d+\)$/.test(text)) continue;
    const digits = /^[❯\s]*(\d+)\./.exec(text);
    kept.push({ text, column: digits ? raw.indexOf(digits[1]!) : -1 });
  }
  kept.forEach(({ text, column: at }, index) => {
    const row = /^(❯\s+)?(\d+)\.(?:\s+(.*))?$/.exec(text);
    const number = row ? Number(row[2]) : 0;
    const label = row ? (row[3] ?? "").trim() : "";
    // rpiv's own checkbox, `[ ]` or `[✔]`: `[x]` is an option's label, not a tick
    const box = row ? /^\[( |✔)\]\s*(.*)$/.exec(label) : null;
    const continues = rows.length === 0 || number === rows.at(-1)!.number + 1;
    if (row && continues && (rows.length === 0 || (at === column && (!boxed || box !== null)))) {
      if (rows.length === 0) {
        column = at;
        boxed = box !== null;
      }
      rows.push({
        number,
        label: box ? box[2]!.trim() : label.replace(/\s*[✔✓]$/, "").trim(),
        description: null,
        cursor: Boolean(row[1]),
        boxed: box !== null,
        checked: box ? box[1] === "✔" : false,
      });
      return;
    }
    const previous = rows.at(-1);
    if (!previous) return;
    // the last line under a list is what commits a multiple choice (`Submit`), or — on a pane too
    // short for the whole list — the description of the last row shown; the caller tells them apart
    if (index === kept.length - 1) {
      last = { label: text.replace(/^❯\s+/, "").trim(), cursor: /^❯\s/.test(text) };
      return;
    }
    previous.description = previous.description ? `${previous.description} ${text}` : text;
  });
  return { rows, last };
}

/** The Submit tab's review: `● Runtime` over `→ Bun`, one pair per question. */
function rpivReviewAnswers(lines: string[]): InteractivePromptAnswer[] {
  const answers: InteractivePromptAnswer[] = [];
  for (const line of lines) {
    const question = /^●\s*(.*)$/.exec(line);
    const answer = /^→\s*(.*)$/.exec(line);
    if (question) answers.push({ question: question[1]!.trim(), answer: null });
    else if (answer && answers.length > 0) answers.at(-1)!.answer = answer[1]!.trim() || null;
  }
  return answers;
}

/**
 * A pane that wraps or clips the text rpiv drew still names the same question: rpiv wraps a long
 * question inside a word and cuts what it draws at the pane's width, so the screen's copy is a
 * wrap of the call's (spaces gone at a break, "questio" over "n") or a long enough beginning of
 * it. Comparing letters and digits alone reads both; the length keeps a short fragment from
 * matching, and a match still needs the rows below it.
 */
function sameWrappedText(shown: string, asked: string): boolean {
  const a = comparable(shown);
  const b = comparable(asked);
  return a === b || (a.length >= 24 && b.startsWith(a));
}

/** What the session's call adds to a card: text the pane wrapped, clipped or never drew at all. */
type RpivCall = {
  header: string;
  question: string;
  multi: boolean;
  recommended: number | null;
  options: { label: string; description: string | null; preview: string | null }[];
};

/**
 * The question the session's open call asked that is the card on screen: matched by its question
 * text and by its options at the numbers the screen's rows carry, never by where its tab stands,
 * and only when it is a multiple choice exactly where the screen's rows are boxed. The rows may be
 * a window of the call's options, or stop before rpiv's own `Type something.` row: a pane shorter
 * than the dialog shows only what fits. None or more than one (a form asked twice, not yet
 * answered) leaves the card screen-only: a guess would tag the wrong row or preview the wrong
 * option.
 */
function rpivCallFor(asks: OmoAsk[], question: string, rows: RpivRow[], multi: boolean): RpivCall | null {
  const matches = asks.flatMap((ask) => ask.questions).filter((asked) => asked.multiSelect === multi
    && sameWrappedText(question, asked.question)
    // a row past the last option is rpiv's free-text row, and nothing else
    && rows.every((row) => row.number <= asked.options.length + 1)
    && rows.every((row) => row.number > asked.options.length || sameWrappedText(row.label, asked.options[row.number - 1]!.label)));
  if (matches.length !== 1) return null;
  const [match] = matches;
  return {
    header: capped(match!.header, PI_ASK_HEADER_CAP),
    question: match!.question,
    multi: match!.multiSelect,
    recommended: match!.recommended ?? null,
    options: match!.options.map((option) => ({
      label: option.label,
      description: option.description,
      preview: option.preview === undefined ? null : capped(option.preview, PI_ASK_PREVIEW_CAP),
    })),
  };
}

/**
 * The card's rows, from the call: the screen's own copy of them is wrapped where the pane is
 * narrow, cut where it is short, and may miss the rows under its bottom entirely. Each row keeps
 * what only the screen knows, where the screen showed it (the cursor, a tick); `Type something.`
 * stays the screen's where rpiv drew it, so a typed answer still reads as that row.
 */
function rpivRowsFromCall(call: RpivCall, shown: RpivRow[]): RpivRow[] {
  const rows = call.options.map((option, index) => {
    const row = shown.find((candidate) => candidate.number === index + 1);
    return {
      number: index + 1,
      label: option.label,
      description: option.description,
      cursor: row?.cursor ?? false,
      boxed: call.multi,
      checked: row?.checked ?? false,
    };
  });
  rows.push(shown.find((row) => row.number === call.options.length + 1)
    ?? { number: call.options.length + 1, label: RPIV_ASK_OTHER_LABEL, description: null, cursor: false, boxed: call.multi, checked: false });
  return rows;
}

/**
 * The questionnaire as a card. The answer is keys into the dialog: rpiv keeps the row indexes
 * and the cursor, ↑/↓ move one row (wrapping, so only the direct delta is sent), Enter picks,
 * Space ticks a multiple choice, and the row under the cursor decides what Enter means.
 *
 * A multiple choice commits on its own row (`Submit`, under the ones it ticks); a single select
 * commits on the row it picks. Both keep `Type something.` last, and moving onto it hands the
 * keyboard to its editor, so its answer is the moves, the text, then Enter. A form of several
 * questions is answered a tab at a time: after the keys rpiv moves on by itself, and the next
 * read is the next card.
 */
function parseRpivAsk(screen: string, piAsks: OmoAsk[] = []): ParsedPrompt | null {
  if (!RPIV_ASK_PROMPT) return null;
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => RPIV_ASK_HINT_RE.test(wrapped(lines, index, 2)));
  if (hintIndex < 0) return null;
  // the block is framed by two rules; the Submit tab keeps its picker between the lower one and the hint
  let bottom = -1;
  for (let index = hintIndex - 1; index >= Math.max(0, hintIndex - 16); index -= 1) {
    if (isDivider(lines[index]!)) { bottom = index; break; }
  }
  let top = -1;
  for (let index = bottom - 1; index >= Math.max(0, bottom - 40); index -= 1) {
    if (isDivider(lines[index]!)) { top = index; break; }
  }
  if (top < 0) return null;
  const body = rpivBody(lines.slice(top + 1, bottom));
  const tabBar = rpivTabs(body[0] ?? "");
  const inside = tabBar.length > 0 ? body.slice(1) : body;
  const under = rpivRows(rpivBody(lines.slice(bottom + 1, hintIndex)));
  // which tab rpiv is on is not written in the screen's text (it marks that tab with colour alone):
  // rpiv moves to the next unanswered tab once one is answered, so the first of those is the one
  // shown, and once every question is answered the card names none
  const questions = tabBar.filter((tab) => !tab.submit);
  const shownTab = questions.findIndex((tab) => !tab.answered);
  const steps = questions.length > 1
    ? questions.map((tab, index) => ({ label: tab.label, answered: tab.answered, current: index === shownTab && under.rows.length === 0 }))
    : undefined;

  if (under.rows.length > 0) {
    // Submit: the answers laid out above the rule, then `Submit answers` over `Cancel`
    const heading = under.rows;
    const prompt = rpivBody(lines.slice(bottom + 1, hintIndex)).map((line) => line.trim())
      .filter((line) => line && !/^(?:❯\s+)?\d+\.\s/.test(line)).join(" ");
    const answers = rpivReviewAnswers(inside.map((line) => line.trim()).filter(Boolean));
    const cancel = heading.findIndex((row) => /^cancel$/i.test(row.label));
    return finishPrompt("pi", {
      kind: "question",
      title: inside.map((line) => line.trim()).find(Boolean) ?? "",
      question: prompt,
      body: null,
      options: heading.map((row) => ({ label: row.label, description: null })),
      multi_select: false,
      custom_option_index: null,
      ...(answers.length > 0 ? { answers } : {}),
      ...(steps ? { steps } : {}),
    }, {
      responder: "pi-ask-submit",
      menuLabels: heading.map((row) => row.label),
      selectedIndex: Math.max(0, heading.findIndex((row) => row.cursor)),
      checkedOptionIndices: [],
      customMenuIndex: null,
      // Cancel leaves the questionnaire unanswered, as Escape does
      rejectWithEscapeIndex: cancel >= 0 ? cancel : null,
    });
  }

  const first = inside.findIndex((line) => /^\s*(?:❯\s+)?\d+\.(?:\s|$)/.test(line));
  if (first < 0) return null;
  const headingLines = inside.slice(0, first).map((line) => line.trim()).filter(Boolean);
  const title = questions.length > 0 ? questions[shownTab]?.label ?? "" : headingLines.length > 1 ? headingLines[0]! : "";
  const shownQuestion = questions.length > 0 ? headingLines.join(" ") : headingLines.length > 1 ? headingLines.slice(1).join(" ") : headingLines[0] ?? "";
  const menu = rpivRows(inside.slice(first));
  if (menu.rows.length === 0) return null;
  const boxed = menu.rows.some((row) => row.boxed);
  // rpiv scrolls a list too long for the pane — `↓`/`↑` on the left, or `(n/total)` over the rows,
  // with the numbering starting past 1 — and a pane shorter than the dialog cuts the list's own
  // rows off at its bottom. Either way the rows off the screen are not on it, so the card is drawn
  // from the session's call when the rows the screen does show are that call's, at their numbers;
  // without it the screen stays terminal text, since the rows it hides cannot be walked to
  const more = [...body, ...lines.slice(bottom + 1, hintIndex)]
    .some((line) => /^[↑↓↕]$/.test(line.trim()) || /^\(\d+\/\d+\)$/.test(line.trim()));
  const clipped = more || menu.rows[0]!.number !== 1;
  const call = rpivCallFor(piAsks, shownQuestion, menu.rows, boxed);
  if (clipped && (call === null || !menu.rows.some((row) => row.cursor)
    // a multiple choice's ticks only come from the rows it drew: with one off the pane the card
    // cannot say which are ticked, and Space would press the wrong ones
    || (boxed && menu.rows.filter((row) => row.number <= call.options.length).length !== call.options.length))) return null;
  // the call's own text and rows: the pane may have wrapped either in the middle of a word
  if (call !== null) {
    menu.rows = rpivRowsFromCall(call, menu.rows);
    menu.last = null;
  }
  const question = call?.question ?? shownQuestion;
  const last = menu.rows.at(-1)!;
  // `Type something.` is always the last numbered row; focused, rpiv redraws it as the editor, so
  // its label is empty (or the text typed into it, which then reads as one more option)
  const custom = last.label === RPIV_ASK_OTHER_LABEL || last.label === "" ? menu.rows.length - 1 : null;
  // a multiple choice commits on the row under its last one (`Submit`), which rpiv draws only once
  // the list ends: a pane too short for it cuts `Type something.` too, and a card that cannot send
  // the commit would leave the question unanswered
  if (boxed && custom === null) return null;
  // a list cut off above the pane's bottom keeps its last row's description in `last`
  if (!boxed && last.description === null && menu.last) last.description = menu.last.label;
  const options = menu.rows.slice(0, custom ?? menu.rows.length).map((row) => ({ label: row.label, description: row.description }));
  if (options.length === 0) return null;
  const cursor = menu.rows.findIndex((row) => row.cursor);
  const selectedIndex = cursor >= 0 ? cursor : menu.last?.cursor ? menu.rows.length : 0;
  // where Enter commits a multiple choice: the row under the ones it ticks, counted from the
  // numbers rpiv printed rather than from how many rows the pane happened to show
  const commit = boxed ? last.number : null;
  const checkedOptionIndices = menu.rows.flatMap((row, index) => (row.checked ? [index] : []));
  return finishPrompt("pi", {
    kind: "question",
    title,
    ...(call === null ? {} : { header: call.header }),
    question,
    body: null,
    options: options.map((option, index) => {
      const preview = call?.options[index]?.preview;
      return preview == null ? option : { ...option, preview };
    }),
    multi_select: boxed,
    custom_option_index: custom,
    ...(call?.recommended == null ? {} : { recommended_index: call.recommended }),
    ...(steps ? { steps } : {}),
  }, {
    responder: "pi-ask",
    menuLabels: menu.rows.map((row) => row.label),
    selectedIndex,
    checkedOptionIndices,
    customMenuIndex: custom,
    rejectWithEscapeIndex: null,
    ...(custom === null ? {} : {
      customSteps: (text: string): AnswerStep[] => [
        ...keySteps(navigationKeys(custom - selectedIndex)), { text }, { keys: [KEY.enter] },
      ],
    }),
    ...(commit === null ? {} : {
      // Space toggles the row under the cursor, so a row that already carries the wanted tick is
      // left alone: only the rows whose box differs from the request are walked to and pressed
      multiSteps: (choices: number[]): AnswerStep[] => {
        const keys: string[] = [];
        let at = selectedIndex;
        for (const index of options.keys()) {
          if (choices.includes(index) === checkedOptionIndices.includes(index)) continue;
          keys.push(...navigationKeys(index - at), KEY.space);
          at = index;
        }
        keys.push(...navigationKeys(commit - at), KEY.enter);
        return keySteps(keys);
      },
    }),
  });
}

// Registered before pi's own menu readers (priority 90): the questionnaire wears pi's hint wording
// but its rows come from the extension's call, so it is read first when the screen shows one.
export const readers: readonly DialogReader[] = [
  {
    id: "pi-ask", agents: ["pi"], priority: 80,
    reread: "before-commit", list: "none",
    parse: (screen, ctx) => {
      const parsed = parseRpivAsk(screen, ctx.piAsks ?? []);
      return parsed?.responder === "pi-ask" ? parsed : null;
    },
  },
  {
    id: "pi-ask-submit", agents: ["pi"], priority: 80,
    reread: "none", list: "none",
    parse: (screen, ctx) => {
      const parsed = parseRpivAsk(screen, ctx.piAsks ?? []);
      return parsed?.responder === "pi-ask-submit" ? parsed : null;
    },
  },
];
