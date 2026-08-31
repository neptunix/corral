import { describe, it, expect } from "vitest";

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
});
