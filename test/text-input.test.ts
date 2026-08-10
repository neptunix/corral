import { describe, expect, it } from "vitest";

import { committedText, createEchoGuard } from "../web/src/lib/text-input";

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

describe("createEchoGuard", () => {
  // Stand-in for setTimeout(0): releases run only when the test says the task boundary happened.
  function manualDefer(): { defer: (fn: () => void) => void; flush: () => void } {
    const queued: (() => void)[] = [];
    return {
      defer: (fn) => { queued.push(fn); },
      flush: () => { const due = queued.splice(0); for (const fn of due) fn(); },
    };
  }

  it("lets the first sender through and drops the echo within the same key event", () => {
    const guard = createEchoGuard(manualDefer().defer);
    expect(guard.claim("ф")).toBe(true);  // xterm's keydown path, or ours — whichever fires first
    expect(guard.claim("ф")).toBe(false); // the other path, same keystroke
  });

  it("does not swallow a different character sent in the same window", () => {
    const guard = createEchoGuard(manualDefer().defer);
    expect(guard.claim("ф")).toBe(true);
    expect(guard.claim("ы")).toBe(true);
  });

  it("allows the same character again once the task boundary released the slot", () => {
    const timers = manualDefer();
    const guard = createEchoGuard(timers.defer);
    expect(guard.claim("ф")).toBe(true);
    timers.flush(); // key event over — a second press is a separate task
    expect(guard.claim("ф")).toBe(true);
  });

  it("guards escape sequences too, not just printable text", () => {
    const guard = createEchoGuard(manualDefer().defer);
    expect(guard.claim("\x1b[A")).toBe(true);
    expect(guard.claim("\x1b[A")).toBe(false);
  });
});
