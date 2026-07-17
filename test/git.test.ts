import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGit } from "../server/git.ts";

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "git-test-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

describe("createGit", () => {
  it("ensureRepo initialises a git repository", async () => {
    const g = createGit(tmpDir);
    await g.ensureRepo();
    expect(existsSync(path.join(tmpDir, ".git"))).toBe(true);
  });

  it("ensureRepo is idempotent (second call does not throw)", async () => {
    const g = createGit(tmpDir);
    await g.ensureRepo();
    await expect(g.ensureRepo()).resolves.toBeUndefined();
  });

  it("start + stop do not throw", () => {
    const g = createGit(tmpDir);
    g.start();
    g.stop();
  });

  it("commits changed files after interval fires", async () => {
    const g = createGit(tmpDir, 50); // 50ms interval for test
    await g.ensureRepo();
    writeFileSync(path.join(tmpDir, "test.json"), '{"x":1}', "utf8");
    g.start();
    // Wait long enough for at least two interval ticks plus git execution time
    await new Promise<void>((resolve) => { setTimeout(resolve, 400); });
    g.stop();
    // Run git log to verify a commit was made
    const { execFileSync } = await import("node:child_process");
    const log = execFileSync("git", ["log", "--oneline"], { cwd: tmpDir, encoding: "utf8" });
    expect(log.trim()).toBeTruthy();
  });
});
