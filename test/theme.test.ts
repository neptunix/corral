import { describe, expect, it } from "vitest";

import { parseMode, resolveTheme, STORAGE_KEY } from "../web/src/lib/theme";

describe("parseMode", () => {
  it("passes through valid modes", () => {
    expect(parseMode("light")).toBe("light");
    expect(parseMode("dark")).toBe("dark");
    expect(parseMode("system")).toBe("system");
  });

  it("falls back to system for null, empty, or garbage", () => {
    expect(parseMode(null)).toBe("system");
    expect(parseMode("")).toBe("system");
    expect(parseMode("nope")).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("system follows the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("explicit modes ignore the OS preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

it("exposes the storage key", () => {
  expect(STORAGE_KEY).toBe("corral-theme");
});
