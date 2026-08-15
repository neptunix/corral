// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  clampScrollSpeed, readTerminalPrefs, writeTerminalPrefs,
  SCROLL_SPEED_DEFAULT, SCROLL_SPEED_MAX, SCROLL_SPEED_MIN,
} from "../web/src/lib/terminal-prefs";

const KEY = "corral.terminal.prefs";

afterEach(() => {
  window.localStorage.clear();
});

describe("terminal prefs — scroll speed clamp", () => {
  // xterm throws on scrollSensitivity <= 0, so this bound is a crash guard.
  it("never returns a value below the minimum", () => {
    expect(clampScrollSpeed(0)).toBe(SCROLL_SPEED_MIN);
    expect(clampScrollSpeed(-5)).toBe(SCROLL_SPEED_MIN);
  });

  it("caps at the maximum", () => {
    expect(clampScrollSpeed(1000)).toBe(SCROLL_SPEED_MAX);
  });

  it("passes an in-range value through untouched", () => {
    expect(clampScrollSpeed(4.5)).toBe(4.5);
  });

  it("falls back to the default on NaN and Infinity", () => {
    expect(clampScrollSpeed(Number.NaN)).toBe(SCROLL_SPEED_DEFAULT);
    expect(clampScrollSpeed(Number.POSITIVE_INFINITY)).toBe(SCROLL_SPEED_DEFAULT);
  });
});

describe("terminal prefs — round trip", () => {
  it("reads back what was written", () => {
    writeTerminalPrefs({ scrollSpeed: 5.5 });
    expect(readTerminalPrefs().scrollSpeed).toBe(5.5);
  });

  // Private-mode Safari throws from the accessors themselves, so the whole object is replaced here —
  // spying on the methods of jsdom's Storage does not actually intercept them.
  it("survives a browser that denies storage access", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => { throw new Error("SecurityError"); },
        setItem: () => { throw new Error("QuotaExceededError"); },
      },
    });
    try {
      expect(() => { writeTerminalPrefs({ scrollSpeed: 4 }); }).not.toThrow();
      expect(readTerminalPrefs().scrollSpeed).toBe(SCROLL_SPEED_DEFAULT);
    } finally {
      if (original !== undefined) Object.defineProperty(window, "localStorage", original);
    }
  });
});

describe("terminal prefs — untrusted storage", () => {
  it("returns the default when nothing is stored", () => {
    expect(readTerminalPrefs().scrollSpeed).toBe(SCROLL_SPEED_DEFAULT);
  });

  it("falls back to the default on unparseable JSON", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(readTerminalPrefs().scrollSpeed).toBe(SCROLL_SPEED_DEFAULT);
  });

  it("falls back to the default when the stored value is not an object", () => {
    window.localStorage.setItem(KEY, '"fast"');
    expect(readTerminalPrefs().scrollSpeed).toBe(SCROLL_SPEED_DEFAULT);
  });

  it("replaces a non-numeric speed with the default", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ scrollSpeed: "fast" }));
    expect(readTerminalPrefs().scrollSpeed).toBe(SCROLL_SPEED_DEFAULT);
  });

  // A hand-edited or older-build value must not reach xterm unclamped.
  it("clamps an out-of-range stored speed", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ scrollSpeed: 0 }));
    expect(readTerminalPrefs().scrollSpeed).toBe(SCROLL_SPEED_MIN);
    window.localStorage.setItem(KEY, JSON.stringify({ scrollSpeed: 99 }));
    expect(readTerminalPrefs().scrollSpeed).toBe(SCROLL_SPEED_MAX);
  });
});
