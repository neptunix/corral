// test/diagnostics-anchors.test.ts
import type { Check } from "@shared/diagnostics-schema";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, it, expect } from "vitest";

// Import every producer and build one representative check list. Reuse the same fixtures the
// per-module tests use; the point is coverage of the `doc` field, not of the verdicts.
import { enumerateChecks } from "../server/diagnostics-sweep.ts";

/** GitHub's slug algorithm, enough of it for our headings: lowercase, drop punctuation, spaces → dashes. */
function slug(heading: string): string {
  return heading.trim().toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

/**
 * Headings OUTSIDE fenced code blocks. README's Quick start is mostly one long ```bash block whose
 * shell comments start with `#`, and counting those as headings lets a dangling anchor pass by
 * matching a comment — a guard that can be satisfied by accident guards nothing.
 */
function headings(md: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of md.split("\n")) {
    if (line.startsWith("```")) { fenced = !fenced; continue; }
    if (!fenced && /^#{1,6}\s/.test(line)) out.push(line.replace(/^#+\s*/, ""));
  }
  return out;
}

describe("README anchors", () => {
  const readme = readFileSync(path.join(import.meta.dirname, "..", "README.md"), "utf8");
  const anchors = new Set(headings(readme).map(slug));

  // async: `versionChecks` returns a Promise, and its three rows carry two of the anchors this
  // task exists to create. A synchronous enumerate would drop exactly what needs checking.
  let checks: readonly Check[] = [];
  beforeAll(async () => { checks = await enumerateChecks(); });

  it("produces checks to inspect", () => {
    expect(checks.length).toBeGreaterThan(10);
  });

  it("sees only real headings — a shell comment in a fenced block is not an anchor", () => {
    expect(anchors.has("quick-start")).toBe(true);
    expect(anchors.has("0-prerequisite-check--without-jq-the-metrics-capture-silently-does-nothing")).toBe(false);
  });

  it("gives every check a doc link", () => {
    const missing = checks.filter((c) => c.doc === null && c.id !== "env-unrunnable").map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it("points every doc link at a heading that exists", () => {
    const dangling = checks
      .filter((c) => c.doc !== null && !anchors.has(c.doc.anchor))
      .map((c) => `${c.id} → #${c.doc?.anchor ?? ""}`);
    expect(dangling).toEqual([]);
  });
});
