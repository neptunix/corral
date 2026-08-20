import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGit } from "../server/git.ts";

// "" until the first commit exists. `git log` exits non-zero on an empty repository and prints to
// stderr, which the poll below would otherwise spray across the run.
const gitLog = (cwd: string): string => {
  try {
    return execFileSync("git", ["log", "--oneline"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

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

  it("start + stop do not throw", async () => {
    const g = createGit(tmpDir);
    g.start();
    await g.stop();
  });

  // The timer fires `void maybeCommit()`, so clearing the interval leaves whatever commit is already
  // running to finish against a directory the caller believes it is done with. In this suite that
  // directory is removed by afterEach, the commit then fails, and its console.warn arrives after the
  // worker has begun teardown — "Closing rpc while onUserConsoleLog was pending", intermittently.
  it("stop() waits for a commit already in flight, so the commit exists once it resolves", async () => {
    const g = createGit(tmpDir, 1);
    await g.ensureRepo();
    // Enough files that `add -A` + `commit` is certainly still running a few ms in. The point is to
    // have a commit IN FLIGHT when stop() is called, not merely to have had one — with a single file
    // the commit can finish first and the assertion then holds against either implementation.
    for (let i = 0; i < 300; i++) writeFileSync(path.join(tmpDir, `f${String(i)}.json`), '{"x":1}', "utf8");
    g.start();
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });

    await g.stop();
    // Asserted WITHOUT polling: if stop() resolved while the commit was still running this is empty.
    // That is what "timer cleared" used to mean, and why afterEach could delete the repo underneath.
    expect(gitLog(tmpDir)).toBeTruthy();
  });

  // setInterval fires regardless of whether the previous commit finished. Two concurrent
  // `git add -A`/`git commit` runs on one repository collide on .git/index.lock, and the loser exits
  // non-zero — so the timer racing itself shows up as a commit that silently did not happen.
  it("never runs two commits at once, however short the interval", async () => {
    const g = createGit(tmpDir, 1);
    await g.ensureRepo();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 40; i++) writeFileSync(path.join(tmpDir, `f${String(i)}.json`), '{"x":1}', "utf8");
      g.start();
      await new Promise<void>((resolve) => { setTimeout(resolve, 500); });
      await g.stop();
      expect(warn).not.toHaveBeenCalled();
      // The outcome, not only the log: hasChanges swallows a failing `git status`, so a tick that
      // loses on index.lock at the status step never reaches that warn. A collision leaves changes
      // uncommitted, and this sees it.
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: tmpDir, encoding: "utf8" }).trim()).toBe("");
    } finally {
      warn.mockRestore();
    }
  });

  it("commits changed files after interval fires", async () => {
    const g = createGit(tmpDir, 10);
    await g.ensureRepo();
    writeFileSync(path.join(tmpDir, "test.json"), '{"x":1}', "utf8");
    g.start();
    try {
      // Poll for the commit rather than sleeping a guessed interval: git's own runtime varies with
      // machine load, and a fixed wait either flakes under a parallel suite or pads every run.
      await vi.waitFor(() => { expect(gitLog(tmpDir)).toBeTruthy(); });
    } finally {
      await g.stop();
    }
  });
});
