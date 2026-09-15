import { describe, expect, it } from "vitest";

import { applyStickyCtrl, arrowSequence, controlCode } from "../web/src/lib/key-bar";

describe("controlCode", () => {
  it("maps letters to their control character, case-insensitively", () => {
    expect(controlCode("c")).toBe("\x03"); // the one everybody needs
    expect(controlCode("C")).toBe("\x03");
    expect(controlCode("a")).toBe("\x01");
    expect(controlCode("z")).toBe("\x1a");
  });

  it("covers the rest of the caret-notation range, not just letters", () => {
    expect(controlCode("@")).toBe("\x00");
    expect(controlCode("[")).toBe("\x1b");
    expect(controlCode("_")).toBe("\x1f");
  });

  it("returns null for anything with no control code, so the caller can send the key untouched", () => {
    expect(controlCode("1")).toBeNull();
    expect(controlCode("ф")).toBeNull();
    expect(controlCode("")).toBeNull();
    expect(controlCode("ab")).toBeNull();
  });
});

describe("arrowSequence", () => {
  const plain = { applicationCursorKeys: false, ctrl: false };

  it("sends CSI in normal cursor mode", () => {
    expect(arrowSequence("up", plain)).toBe("\x1b[A");
    expect(arrowSequence("down", plain)).toBe("\x1b[B");
    expect(arrowSequence("right", plain)).toBe("\x1b[C");
    expect(arrowSequence("left", plain)).toBe("\x1b[D");
  });

  it("switches to SS3 under DECCKM — an app that asked for it ignores the CSI form", () => {
    const app = { applicationCursorKeys: true, ctrl: false };
    expect(arrowSequence("up", app)).toBe("\x1bOA");
    expect(arrowSequence("left", app)).toBe("\x1bOD");
  });

  it("uses the parameterised CSI for Ctrl, in either cursor mode — SS3 cannot carry a modifier", () => {
    expect(arrowSequence("right", { applicationCursorKeys: false, ctrl: true })).toBe("\x1b[1;5C");
    expect(arrowSequence("right", { applicationCursorKeys: true, ctrl: true })).toBe("\x1b[1;5C");
  });
});

describe("applyStickyCtrl", () => {
  it("turns the next typed character into its control code — the Ctrl+C case", () => {
    expect(applyStickyCtrl("c", true)).toEqual({ text: "\x03", consumed: true });
  });

  it("passes input through untouched when nothing is armed", () => {
    expect(applyStickyCtrl("c", false)).toEqual({ text: "c", consumed: false });
  });

  it("consumes the modifier even on a character with no control code", () => {
    // Otherwise it would stay armed and silently modify some later, unrelated key.
    expect(applyStickyCtrl("ф", true)).toEqual({ text: "ф", consumed: true });
  });

  it("leaves escape sequences and mouse reports alone, and keeps the modifier armed", () => {
    // touch-scroll turns a swipe into wheel reports on this very channel.
    expect(applyStickyCtrl("\x1b[M#!!", true)).toEqual({ text: "\x1b[M#!!", consumed: false });
    expect(applyStickyCtrl("\x1b[A", true)).toEqual({ text: "\x1b[A", consumed: false });
    expect(applyStickyCtrl("", true)).toEqual({ text: "", consumed: false });
  });
});
