import { describe, it, expect } from "vitest";

import { resetCountdown, isStale } from "../web/src/lib/time.ts";

describe("resetCountdown", () => {
  const now = 1_000_000_000_000; // ms
  it("formats hours+minutes under a day", () => {
    expect(resetCountdown(1_000_000_000 + 2 * 3600 + 10 * 60, now)).toBe("2h10m");
  });
  it("formats days+hours over a day", () => {
    expect(resetCountdown(1_000_000_000 + 3 * 86400 + 4 * 3600, now)).toBe("3d4h");
  });
  it("returns — for null or past resets", () => {
    expect(resetCountdown(null, now)).toBe("—");
    expect(resetCountdown(1_000_000_000 - 100, now)).toBe("—");
  });
});

describe("isStale", () => {
  const now = 1_000_000_000_000;
  it("is false within threshold, true beyond", () => {
    expect(isStale(1_000_000_000 - 30, now, 120000)).toBe(false); // 30s ago
    expect(isStale(1_000_000_000 - 300, now, 120000)).toBe(true); // 5m ago
  });
  it("defaults to a 5-minute threshold", () => {
    expect(isStale(1_000_000_000 - 240, now)).toBe(false); // 4m ago → fresh
    expect(isStale(1_000_000_000 - 360, now)).toBe(true); // 6m ago → stale
  });
});
