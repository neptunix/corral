import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { PACKAGE_JSON_PATH, readSelfVersion } from "../server/self-version.ts";

describe("readSelfVersion", () => {
  it("reads the real package.json — the field must exist", () => {
    expect(readSelfVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("points at the repo's package.json, not a copy", () => {
    const parsed: unknown = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    expect(parsed).toHaveProperty("name", "corral");
  });

  it("returns null on malformed JSON rather than throwing — a bad read must not kill the server", () => {
    expect(readSelfVersion(() => "{not json")).toBe(null);
  });

  it("returns null when version is missing or empty", () => {
    expect(readSelfVersion(() => '{"name":"corral"}')).toBe(null);
    expect(readSelfVersion(() => '{"name":"corral","version":""}')).toBe(null);
  });

  it("returns null when the read itself fails", () => {
    expect(readSelfVersion(() => { throw new Error("ENOENT"); })).toBe(null);
  });
});
