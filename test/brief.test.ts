import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BRIEF_PREAMBLE, briefByteLength, cleanupBrief, composeBrief, sweepBriefRoot, writeBrief } from "../server/brief.ts";

describe("brief store", () => {
  let root: string;
  beforeEach(() => { root = path.join(mkdtempSync(path.join(os.tmpdir(), "brief-")), "briefs"); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("prepends the whoami preamble and keeps the brief verbatim", () => {
    const out = composeBrief("Continue the API refactor.\n\nNext: wire the parser.");
    expect(out.startsWith(BRIEF_PREAMBLE)).toBe(true);
    expect(out).toContain("Continue the API refactor.\n\nNext: wire the parser.");
    expect(out.split("\n")[1]).toBe(""); // blank line between preamble and brief
  });

  it("measures size in bytes, not characters", () => {
    expect(briefByteLength("abc")).toBe(3);
    expect(briefByteLength("—")).toBe(3); // one char, three UTF-8 bytes
  });

  it("writes under the root with a generated name and returns an absolute path", async () => {
    const p = await writeBrief(root, "hello");
    expect(path.isAbsolute(p)).toBe(true);
    expect(path.dirname(p)).toBe(root);
    expect(p.endsWith(".md")).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("hello");
  });

  it("leaves no temp file behind (atomic write)", async () => {
    const p = await writeBrief(root, "hello");
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });

  it("generates a distinct path per call", async () => {
    const a = await writeBrief(root, "a");
    const b = await writeBrief(root, "b");
    expect(a).not.toBe(b);
    expect(readFileSync(a, "utf8")).toBe("a");
    expect(readFileSync(b, "utf8")).toBe("b");
  });

  it("produces a filename with no shell metacharacters", async () => {
    const p = await writeBrief(root, "x");
    expect(/^[A-Za-z0-9_-]+\.md$/.test(path.basename(p))).toBe(true);
  });

  it("sweeps the root and never throws when it is already gone", async () => {
    await writeBrief(root, "x");
    await sweepBriefRoot(root);
    expect(existsSync(root)).toBe(false);
    await expect(sweepBriefRoot(root)).resolves.toBeUndefined();
  });

  it("cleanupBrief removes a single brief file", async () => {
    const p = await writeBrief(root, "hello");
    await cleanupBrief(p);
    expect(existsSync(p)).toBe(false);
  });

  it("cleanupBrief never throws when the file is already gone", async () => {
    await expect(cleanupBrief(path.join(root, "nonexistent.md"))).resolves.toBeUndefined();
  });
});
