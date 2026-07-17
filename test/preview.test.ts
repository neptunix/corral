import { describe, expect, it } from "vitest";

import { toSnapshotPreview } from "../web/src/lib/preview.ts";

// Pins the Unassigned mini-terminal display contract: a snapshot read maps to the SessionCard
// `preview` prop. null = still loading (show a placeholder, not the "no output" copy); whitespace-only
// = genuinely empty (captured:false → "no output captured"); real text = captured.
describe("toSnapshotPreview", () => {
  it("shows a loading placeholder (captured) before the first read resolves", () => {
    const p = toSnapshotPreview(null);
    expect(p.captured).toBe(true);
    expect(p.text).not.toBe("");
  });

  it("treats empty / whitespace-only output as not captured", () => {
    expect(toSnapshotPreview("")).toEqual({ text: "", captured: false });
    expect(toSnapshotPreview("   \n  ")).toEqual({ text: "", captured: false });
  });

  it("passes real output through as captured", () => {
    expect(toSnapshotPreview("● building…\n> npm run check")).toEqual({
      text: "● building…\n> npm run check", captured: true,
    });
  });
});
