import { describe, expect, it } from "vitest";

import { committedText } from "../web/src/lib/text-input";

// The IM-routed keystroke this exists for: Firefox delivers keydown {key:"Process", keyCode:229} and the
// character only as beforeinput data. xterm's own paths are dead or unreliable there (see text-input.ts).
const IME_CYRILLIC = { isComposing: false, inputType: "insertText", data: "ф" } as const;

describe("committedText", () => {
  it("claims committed plain text", () => {
    expect(committedText(IME_CYRILLIC)).toBe("ф");
  });

  it("claims multi-character commits (dictation, autocorrect, emoji picker)", () => {
    expect(committedText({ isComposing: false, inputType: "insertText", data: "привет" })).toBe("привет");
  });

  it("leaves a composition to xterm's CompositionHelper", () => {
    expect(committedText({ ...IME_CYRILLIC, isComposing: true })).toBeNull();
    expect(committedText({ isComposing: false, inputType: "insertCompositionText", data: "ф" })).toBeNull();
  });

  it("leaves deletions and history alone — those arrive as real keys xterm already handles", () => {
    for (const inputType of ["deleteContentBackward", "deleteContentForward", "historyUndo", "historyRedo"]) {
      expect(committedText({ isComposing: false, inputType, data: null })).toBeNull();
    }
  });

  it("ignores insertText carrying nothing", () => {
    expect(committedText({ isComposing: false, inputType: "insertText", data: null })).toBeNull();
    expect(committedText({ isComposing: false, inputType: "insertText", data: "" })).toBeNull();
  });

  it("does not claim paste — corral brackets that itself on the paste event", () => {
    expect(committedText({ isComposing: false, inputType: "insertFromPaste", data: "x" })).toBeNull();
  });
});
