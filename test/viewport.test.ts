import { describe, it, expect } from "vitest";

import { MIN_SIZED_COLS } from "../config.ts";
import { lastViewport, recordViewport } from "../server/viewport.ts";

describe("viewport memory", () => {
  it("is null before anything is recorded", () => {
    expect(lastViewport()).toBeNull();
  });

  it("returns the last recorded pair", () => {
    recordViewport(188, 45);
    expect(lastViewport()).toEqual({ cols: 188, rows: 45 });
    recordViewport(120, 30);
    expect(lastViewport()).toEqual({ cols: 120, rows: 30 });
  });

  it("ignores a reading below the floor, leaving the previous value standing", () => {
    recordViewport(150, 40);
    recordViewport(MIN_SIZED_COLS - 1, 24);
    expect(lastViewport()).toEqual({ cols: 150, rows: 40 });
  });

  it("keeps a reading at exactly the floor (boundary)", () => {
    recordViewport(MIN_SIZED_COLS, 24);
    expect(lastViewport()).toEqual({ cols: MIN_SIZED_COLS, rows: 24 });
  });
});
