import { describe, expect, it } from "bun:test";
import { matchPiKey, parsePiChord, piChordKeys, piKeymap, piKeyPress, PI_KEY_DEFAULTS, type PiChordEvent } from "./usePiKeys.ts";

const press = (key: string, mods: Partial<PiChordEvent> = {}): PiChordEvent => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
const box = (value: string, selection = 0) => ({ value, selectionStart: selection, selectionEnd: selection });
const selected = (value: string) => ({ value, selectionStart: 0, selectionEnd: 2 });

describe("parsePiChord", () => {
  it("reads the modifiers Pi's syntax names", () => {
    expect(parsePiChord("ctrl+l")).toEqual({ ctrl: true, shift: false, alt: false, meta: false, key: "l" });
    expect(parsePiChord("shift+ctrl+p")).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: "p" });
    expect(parsePiChord("Alt+Enter")).toEqual({ ctrl: false, shift: false, alt: true, meta: false, key: "enter" });
    expect(parsePiChord("shift+tab")).toEqual({ ctrl: false, shift: true, alt: false, meta: false, key: "tab" });
    expect(parsePiChord("super+k")?.meta).toBe(true);
    expect(parsePiChord("esc")?.key).toBe("escape");
    expect(parsePiChord("f12")?.key).toBe("f12");
  });

  it("refuses what the browser could not express", () => {
    expect(parsePiChord("hyper+l")).toBeNull();
    expect(parsePiChord("f13")).toBeNull();
    expect(parsePiChord("notakey")).toBeNull();
    expect(parsePiChord("")).toBeNull();
  });
});

describe("piKeymap", () => {
  it("keeps Pi's defaults without a file", () => {
    expect(piKeymap({ keys: {} })).toEqual(PI_KEY_DEFAULTS);
    expect(piKeymap(null)).toEqual(PI_KEY_DEFAULTS);
    expect(piKeymap({ keys: { "app.model.select": undefined } })["app.model.select"]).toEqual(["ctrl+l"]);
  });

  it("takes a string or a list, and an empty list disables the action", () => {
    const map = piKeymap({ keys: { "app.model.select": "ctrl+m", "app.thinking.cycle": ["shift+tab", "ctrl+g"], "app.tools.expand": [] } });
    expect(map["app.model.select"]).toEqual(["ctrl+m"]);
    expect(map["app.thinking.cycle"]).toEqual(["shift+tab", "ctrl+g"]);
    expect(map["app.tools.expand"]).toEqual([]);
    expect(map["app.message.followUp"]).toEqual(["alt+enter"]);
  });

  it("returns only the ids the web offers", () => {
    const map = piKeymap({ keys: { "app.session.tree": "ctrl+shift+t", "app.exit": "ctrl+d" } });
    expect(Object.keys(map).sort()).toEqual(Object.keys(PI_KEY_DEFAULTS).sort());
  });
});

describe("matchPiKey", () => {
  const map = piKeymap({ keys: {} });

  it("maps Pi's default chords to the box's actions", () => {
    expect(matchPiKey(press("l", { ctrlKey: true }), map)).toBe("model-picker");
    expect(matchPiKey(press("P", { ctrlKey: true }), map)).toBe("model-next");
    expect(matchPiKey(press("p", { ctrlKey: true, shiftKey: true }), map)).toBe("model-previous");
    expect(matchPiKey(press("Tab", { shiftKey: true }), map)).toBe("thinking-cycle");
    expect(matchPiKey(press("t", { ctrlKey: true }), map)).toBe("thinking-toggle");
    expect(matchPiKey(press("o", { ctrlKey: true }), map)).toBe("tools-expand");
    expect(matchPiKey(press("Enter", { altKey: true }), map)).toBe("message-follow-up");
    expect(matchPiKey(press("ArrowUp", { altKey: true }), map)).toBe("message-dequeue");
  });

  it("leaves a bare key its text, and a wrong chord alone", () => {
    expect(matchPiKey(press("l"), map)).toBeNull();
    expect(matchPiKey(press("Tab"), map)).toBeNull();
    expect(matchPiKey(press("l", { ctrlKey: true, shiftKey: true }), map)).toBeNull();
    expect(matchPiKey(press("l", { ctrlKey: true, isComposing: true }), map)).toBeNull();
  });

  it("follows a remap, and a disabled action has no chord", () => {
    const remapped = piKeymap({ keys: { "app.model.select": "ctrl+m", "app.thinking.cycle": [] } });
    expect(matchPiKey(press("m", { ctrlKey: true }), remapped)).toBe("model-picker");
    expect(matchPiKey(press("l", { ctrlKey: true }), remapped)).toBeNull();
    expect(matchPiKey(press("Tab", { shiftKey: true }), remapped)).toBeNull();
  });
});

describe("piKeyPress", () => {
  const map = piKeymap({ keys: {} });

  it("clears an empty selection and copies a selection", () => {
    expect(piKeyPress(press("c", { ctrlKey: true }), box("a draft"), map, true)).toBe("clear");
    expect(piKeyPress(press("c", { ctrlKey: true }), selected("a draft"), map, true)).toBeNull();
    expect(piKeyPress(press("c", { ctrlKey: true }), box(""), map, true)).toBeNull();
  });

  it("releases every chord, Shift+Tab included, with the preference off", () => {
    expect(piKeyPress(press("Tab", { shiftKey: true }), box(""), map, false)).toBeNull();
    expect(piKeyPress(press("l", { ctrlKey: true }), box(""), map, false)).toBeNull();
    expect(piKeyPress(press("c", { ctrlKey: true }), box("a draft"), map, false)).toBeNull();
  });
});

describe("piChordKeys", () => {
  it("draws a chord's modifiers in macOS order with a readable key", () => {
    expect(piChordKeys("ctrl+l")).toEqual(["Ctrl", "L"]);
    expect(piChordKeys("shift+ctrl+p")).toEqual(["Ctrl", "Shift", "P"]);
    expect(piChordKeys("alt+enter")).toEqual(["Alt", "Enter"]);
    expect(piChordKeys("shift+tab")).toEqual(["Shift", "Tab"]);
    expect(piChordKeys("super+pageUp".toLowerCase())).toEqual(["Meta", "PageUp"]);
    // a chord the browser could not express is shown as the file wrote it
    expect(piChordKeys("hyper+l")).toEqual(["hyper+l"]);
  });
});
