import { describe, it, expect } from "vitest";

import { contextLevelClass, usageLevelClass } from "../web/src/lib/level.ts";

describe("usageLevelClass (5h/7d rate windows: 50/80)", () => {
  it("green below 50%", () => {
    expect(usageLevelClass(0)).toContain("green");
    expect(usageLevelClass(49)).toContain("green");
  });
  it("amber in [50, 80)", () => {
    expect(usageLevelClass(50)).toContain("amber");
    expect(usageLevelClass(79)).toContain("amber");
  });
  it("red at 80% and above", () => {
    expect(usageLevelClass(80)).toContain("red");
    expect(usageLevelClass(100)).toContain("red");
  });
});

describe("contextLevelClass (context fill: 35/50, warns earlier)", () => {
  it("green below 35%", () => {
    expect(contextLevelClass(0)).toContain("green");
    expect(contextLevelClass(34)).toContain("green");
  });
  it("amber in [35, 50)", () => {
    expect(contextLevelClass(35)).toContain("amber");
    expect(contextLevelClass(49)).toContain("amber");
  });
  it("red at 50% and above (e.g. 55% is red)", () => {
    expect(contextLevelClass(50)).toContain("red");
    expect(contextLevelClass(55)).toContain("red");
  });
});

describe("both carry a light-mode override on every level", () => {
  it("has light: on each band", () => {
    for (const fn of [usageLevelClass, contextLevelClass]) {
      for (const pct of [10, 40, 90]) expect(fn(pct)).toContain("light:");
    }
  });
});
