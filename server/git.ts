import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { GIT_COMMIT_INTERVAL_MS } from "../config.ts";

function git(cwd: string, args: readonly string[]): Promise<void> {
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
  stop(): void;
} {
  let timer: ReturnType<typeof setInterval> | null = null;

  async function maybeCommit(): Promise<void> {
    try {
      if (!(await hasChanges(dataDir))) return;
      await git(dataDir, ["add", "-A"]);
      await git(dataDir, ["commit", "-m", "auto: board data update"]);
    } catch (err) {
      console.warn("[git] commit failed:", err instanceof Error ? err.message : String(err));
    }
  }

  return {
    async ensureRepo() {
      if (existsSync(path.join(dataDir, ".git"))) return;
      await git(dataDir, ["init"]);
      await git(dataDir, ["config", "user.name", "corral"]);
      await git(dataDir, ["config", "user.email", "corral@localhost"]);
    },

    start() {
      timer = setInterval(() => { void maybeCommit(); }, intervalMs);
    },

    stop() {
      if (timer !== null) { clearInterval(timer); timer = null; }
    },
  };
}
