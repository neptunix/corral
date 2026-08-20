import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { GIT_COMMIT_INTERVAL_MS } from "../config.ts";

export function runGit(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, timeout: 15_000 }, (err) => {
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

async function hasChanges(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["status", "--porcelain"], { cwd, timeout: 5_000 }, (err, stdout) => {
      if (err) { resolve(false); return; }
      resolve(stdout.trim().length > 0);
    });
  });
}

export function createGit(dataDir: string, intervalMs = GIT_COMMIT_INTERVAL_MS): {
  ensureRepo(): Promise<void>;
  start(): void;
  /** Resolves once the timer is cleared AND any commit already running has settled. */
  stop(): Promise<void>;
} {
  let timer: ReturnType<typeof setInterval> | null = null;
  // setInterval fires whether or not the previous commit finished, and two concurrent `add -A`/
  // `commit` runs on one repository collide on .git/index.lock — the loser exits non-zero and its
  // changes simply do not get committed. So a tick is SKIPPED while one is already running: nothing is
  // lost, because the next tick re-reads `git status --porcelain` and picks up whatever is still there.
  //
  // Holding that promise is also what lets stop() mean "done" rather than "timer cleared". A caller
  // that tears dataDir down straight after stop() would otherwise race a live git subprocess, which
  // then fails and logs from a promise nobody is watching.
  let inFlight: Promise<void> | null = null;

  async function maybeCommit(): Promise<void> {
    try {
      if (!(await hasChanges(dataDir))) return;
      await runGit(dataDir, ["add", "-A"]);
      await runGit(dataDir, ["commit", "-m", "auto: board data update"]);
    } catch (err) {
      console.warn("[git] commit failed:", err instanceof Error ? err.message : String(err));
    }
  }

  return {
    async ensureRepo() {
      if (existsSync(path.join(dataDir, ".git"))) return;
      await runGit(dataDir, ["init"]);
      await runGit(dataDir, ["config", "user.name", "corral"]);
      await runGit(dataDir, ["config", "user.email", "corral@localhost"]);
    },

    start() {
      timer = setInterval(() => {
        if (inFlight !== null) return;
        inFlight = maybeCommit().finally(() => { inFlight = null; });
      }, intervalMs);
    },

    async stop() {
      if (timer !== null) { clearInterval(timer); timer = null; }
      await inFlight; // maybeCommit swallows its own failures, so this never rejects
    },
  };
}
