import { describe, expect, it } from "bun:test";
import type { PiNativeState } from "../../shared/protocol.ts";
import { initialPiNativeState } from "../../server/pi-rpc.ts";
import { piChipChange, piComposerMode } from "./piComposer.ts";

const state = (mode: PiNativeState["mode"]): PiNativeState => ({ ...initialPiNativeState(), mode });

describe("a Pi pane's composer", () => {
  it("draws live chips on a pane the chat drives over RPC", () => {
    expect(piComposerMode({ agent: "pi", piNative: state("native"), modelKnown: true })).toEqual(
      { chips: true, disabled: false, readOnly: false, lost: false, connecting: false },
    );
    // the chips are drawn before the session file names a model: Pi's own answer fills them
    expect(piComposerMode({ agent: "pi", piNative: state("native"), modelKnown: false }).chips).toBe(true);
  });

  it("cannot be pressed while Pi starts, and says so in its status line", () => {
    const connecting = piComposerMode({ agent: "pi", piNative: state("connecting"), modelKnown: false });
    expect(connecting).toEqual({ chips: true, disabled: true, readOnly: false, lost: false, connecting: true });
  });

  it("offers no chip on a lost Pi, which keeps its notice and its draft", () => {
    const lost = piComposerMode({ agent: "pi", piNative: state("lost"), modelKnown: true });
    expect(lost).toEqual({ chips: true, disabled: true, readOnly: false, lost: true, connecting: false });
  });

  it("reads a Pi the terminal owns, and names where it is changed", () => {
    expect(piComposerMode({ agent: "pi", piNative: null, modelKnown: true })).toEqual(
      { chips: true, disabled: false, readOnly: true, lost: false, connecting: false },
    );
    // a session file that named no model leaves nothing to draw
    expect(piComposerMode({ agent: "pi", piNative: null, modelKnown: false }).chips).toBe(false);
  });

  it("leaves every other agent exactly as it was", () => {
    for (const agent of ["claude", "codex", null]) {
      expect(piComposerMode({ agent, piNative: null, modelKnown: true })).toEqual(
        { chips: false, disabled: false, readOnly: false, lost: false, connecting: false },
      );
      expect(piComposerMode({ agent, piNative: state("native"), modelKnown: true }).chips).toBe(false);
    }
  });
});

describe("a chip the reader changed", () => {
  const drawn = (model: string | null, level: string | null) => ({ model, level });

  it("names the model a pick switched to, over the level the model reset", () => {
    expect(piChipChange(drawn("Claude Sonnet 4.5", "high"), drawn("GPT-5", "off"))).toBe("model");
    expect(piChipChange(drawn("GPT-5", "off"), drawn("GPT-5", "high"))).toBe("level");
  });

  it("says nothing for the first value drawn, and nothing for a pane that stopped being native", () => {
    expect(piChipChange(null, drawn("GPT-5", "high"))).toBe(null);
    expect(piChipChange(drawn("GPT-5", "high"), null)).toBe(null);
  });

  it("says nothing when the chips drew the same words again", () => {
    expect(piChipChange(drawn("GPT-5", "high"), drawn("GPT-5", "high"))).toBe(null);
    // a level Pi has not answered yet is no level to name
    expect(piChipChange(drawn("GPT-5", null), drawn("GPT-5", null))).toBe(null);
  });
});
