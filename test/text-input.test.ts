import { describe, expect, it } from "vitest";

import { committedText, isImSwallowedKeydown } from "../web/src/lib/text-input";

describe("isImSwallowedKeydown", () => {
  it("recognises the Firefox-behind-ibus keydown this module exists for", () => {
    // Measured on Linux/Firefox with a Cyrillic layout: the character is nowhere in the key event.
    expect(isImSwallowedKeydown({ key: "Process", keyCode: 229 })).toBe(true);
  });

  it("recognises an engine that reports Unidentified instead of Process", () => {
    expect(isImSwallowedKeydown({ key: "Unidentified", keyCode: 229 })).toBe(true);
  });

  it("does NOT claim the iOS software keyboard, which reports 229 with the real character", () => {
    // There xterm's own _inputEvent path handles the insertion; claiming it sends the letter twice.
    expect(isImSwallowedKeydown({ key: "ф", keyCode: 229 })).toBe(false);
    expect(isImSwallowedKeydown({ key: "a", keyCode: 229 })).toBe(false);
  });

  it("does not claim ordinary keydowns", () => {
    expect(isImSwallowedKeydown({ key: "a", keyCode: 65 })).toBe(false);
    expect(isImSwallowedKeydown({ key: "ф", keyCode: 0 })).toBe(false);
    expect(isImSwallowedKeydown({ key: "Enter", keyCode: 13 })).toBe(false);
    expect(isImSwallowedKeydown({ key: "Backspace", keyCode: 8 })).toBe(false);
  });
});

describe("committedText", () => {
  const AFTER_IM = { isComposing: false, inputType: "insertText", afterImKeydown: true } as const;

  it("claims committed plain text after an IM-swallowed keydown", () => {
    expect(committedText({ ...AFTER_IM, data: "ф" })).toBe("ф");
  });

  it("claims multi-character commits", () => {
    expect(committedText({ ...AFTER_IM, data: "привет" })).toBe("привет");
  });

  it("claims nothing when the keydown was not IM-swallowed — xterm already sent it", () => {
    expect(committedText({ ...AFTER_IM, data: "ф", afterImKeydown: false })).toBeNull();
  });

  it("leaves a composition to xterm's CompositionHelper", () => {
    expect(committedText({ ...AFTER_IM, data: "ф", isComposing: true })).toBeNull();
    expect(committedText({ ...AFTER_IM, data: "ф", inputType: "insertCompositionText" })).toBeNull();
  });

  it("leaves deletions and history alone — those arrive as real keys xterm already handles", () => {
    for (const inputType of ["deleteContentBackward", "deleteContentForward", "historyUndo", "historyRedo"]) {
      expect(committedText({ ...AFTER_IM, inputType, data: null })).toBeNull();
    }
  });

  it("ignores insertText carrying nothing", () => {
    expect(committedText({ ...AFTER_IM, data: null })).toBeNull();
    expect(committedText({ ...AFTER_IM, data: "" })).toBeNull();
  });

  it("does not claim paste — corral brackets that itself on the paste event", () => {
    expect(committedText({ ...AFTER_IM, inputType: "insertFromPaste", data: "x" })).toBeNull();
  });
});
