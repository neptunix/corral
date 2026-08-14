import type { RecapSource, RecapStatus } from "@shared/schema";
import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { RECAP_CONTENT_MAX, RECAP_READ_TIMEOUT_MS, RECAP_TAIL_BYTES } from "../config.ts";
import type { HerdrEnv } from "../environments.ts";
import { defaultExec, type ExecFn } from "./herdr.ts";

const SSH_FLAGS = ["-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes"];

// Validates that a path returned from a remote ls command contains no shell metacharacters.
// Must be checked before interpolating into an SSH command string.
const SAFE_REMOTE_PATH_RE = /^[A-Za-z0-9~/._:@/-]+$/;

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function findTranscriptLocal(
  configDir: string,
  sessionId: string,
): Promise<{ filePath: string; mtime: number } | null> {
  const resolvedConfig = path.resolve(configDir);
  const projectsDir = path.join(resolvedConfig, "projects");
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return null;
  }
  const candidates: { filePath: string; mtime: number }[] = [];
  for (const entry of entries) {
    const candidate = path.join(projectsDir, entry, `${sessionId}.jsonl`);
    const resolvedCandidate = path.resolve(candidate);
    const prefix = resolvedConfig + path.sep + "projects" + path.sep;
    if (!resolvedCandidate.startsWith(prefix)) continue;
    try {
      const s = await stat(candidate);
      candidates.push({ filePath: candidate, mtime: s.mtimeMs });
    } catch {
      // file doesn't exist
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    console.warn(`[recap] multiple transcripts for session ${sessionId.slice(0, 8)}… in ${configDir} — using newest`);
  }
  return candidates.reduce((best, c) => (c.mtime > best.mtime ? c : best));
}

async function findTranscriptRemote(
  env: Extract<HerdrEnv, { kind: "remote" }>,
  configDir: string,
  sessionId: string,
  exec: ExecFn,
): Promise<string | null> {
  const sshCmd = `ls ${configDir}/projects/*/${sessionId}.jsonl 2>/dev/null`;
  try {
    const { stdout } = await exec(
      "ssh",
      [...SSH_FLAGS, env.sshHost, sshCmd],
      { timeout: RECAP_READ_TIMEOUT_MS },
    );
    const line = stdout.trim().split("\n")[0];
    if (line === undefined || line === "" || !SAFE_REMOTE_PATH_RE.test(line)) return null;
    return line;
  } catch {
    return null;
  }
}

export async function findTranscript(
  env: HerdrEnv,
  sessionId: string,
  exec?: ExecFn,
): Promise<string | null> {
  const execFn = exec ?? defaultExec;
  for (const configDir of env.claudeConfigDirs) {
    if (env.kind === "local") {
      const found = await findTranscriptLocal(configDir, sessionId);
      if (found !== null) return found.filePath;
    } else {
      const found = await findTranscriptRemote(env, configDir, sessionId, execFn);
      if (found !== null) return found;
    }
  }
  return null;
}

async function readTailLocal(filePath: string, configDirs: readonly string[]): Promise<string> {
  const resolved = path.resolve(filePath);
  const safe = configDirs.some((d) => {
    const prefix = path.resolve(d) + path.sep + "projects" + path.sep;
    return resolved.startsWith(prefix);
  });
  if (!safe) {
    throw new Error(`transcript path ${resolved} is outside a valid configDir/projects/ tree`);
  }
  // O_NOFOLLOW: reject if filePath is a symlink (prevents reading arbitrary files via a crafted link)
  const fd = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await fd.stat();
    const start = Math.max(0, size - RECAP_TAIL_BYTES);
    const length = size - start;
    if (length === 0) return "";
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fd.read(buf, 0, length, start);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      // Discard partial leading line — the read may start mid-JSON
      const nl = text.indexOf("\n");
      return nl === -1 ? "" : text.slice(nl + 1);
    }
    return text;
  } finally {
    await fd.close();
  }
}

async function readTailRemote(
  env: Extract<HerdrEnv, { kind: "remote" }>,
  filePath: string,
  exec: ExecFn,
): Promise<string> {
  // filePath originates from findTranscriptRemote (glob over configDir/projects/*/ — no free-text input)
  const sshCmd = `tail -c ${String(RECAP_TAIL_BYTES)} ${filePath}`;
  const { stdout } = await exec(
    "ssh",
    [...SSH_FLAGS, env.sshHost, sshCmd],
    { timeout: RECAP_READ_TIMEOUT_MS },
  );
  return stdout.length > RECAP_TAIL_BYTES ? stdout.slice(stdout.length - RECAP_TAIL_BYTES) : stdout;
}

export async function readTail(
  env: HerdrEnv,
  filePath: string,
  exec?: ExecFn,
): Promise<string> {
  if (env.kind === "local") {
    return readTailLocal(filePath, env.claudeConfigDirs);
  }
  return readTailRemote(env, filePath, exec ?? defaultExec);
}

export function lastRecord(
  tail: string,
  pred: (r: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isJsonObject(parsed)) continue;
    if (pred(parsed)) return parsed;
  }
  return null;
}

/**
 * The recap ladder, best rung first. Tried in THIS order — by priority, never by position in the file:
 * `last-prompt` is rewritten on every turn, so it is all but always the last candidate present, and
 * ordering by position would bury every `away_summary` that exists.
 *
 * Only `away_summary` is Claude summarizing its own work, and it is emitted only while the terminal
 * reports focus-out — which corral's own board stopped producing (design doc
 * `docs/adr/0005`; measured: 1.7% of transcripts, none after
 * 2026-07-31). The two lower rungs are written independently of focus: `ai-title` on 23% of
 * transcripts, `last-prompt` on 100%.
 *
 * `custom-title` / `agent-name` are deliberately NOT rungs — they hold the session name, which corral
 * already shows as the tab label and in the statusline, so they would only echo it back.
 */
const RECAP_LADDER: readonly { readonly source: RecapSource; readonly field: string; readonly pred: (r: Record<string, unknown>) => boolean }[] = [
  { source: "away-summary", field: "content", pred: (r) => r.type === "system" && r.subtype === "away_summary" },
  { source: "ai-title", field: "aiTitle", pred: (r) => r.type === "ai-title" },
  { source: "last-prompt", field: "lastPrompt", pred: (r) => r.type === "last-prompt" },
];

export async function readRecap(
  env: HerdrEnv,
  sessionId: string,
  exec?: ExecFn,
): Promise<{ recap: string | null; status: RecapStatus; source: RecapSource | null }> {
  const transcriptPath = await findTranscript(env, sessionId, exec);
  if (transcriptPath === null) return { recap: null, status: "not-found", source: null };

  let tail: string;
  try {
    tail = await readTail(env, transcriptPath, exec);
  } catch {
    return { recap: null, status: "read-error", source: null };
  }

  for (const rung of RECAP_LADDER) {
    const record = lastRecord(tail, rung.pred);
    if (record === null) continue;
    const value = record[rung.field];
    // A rung whose payload is missing, non-string or blank is not a dead end — keep descending. The
    // single-source read this replaced reported no-summary here and showed nothing.
    if (typeof value !== "string" || value.trim() === "") continue;
    return { recap: value.slice(0, RECAP_CONTENT_MAX), status: "ok", source: rung.source };
  }
  return { recap: null, status: "no-summary", source: null };
}

// Authoritative cwd for `claude --resume <uuid>`: the working directory the session recorded in its
// own transcript. `claude --resume` is cwd-scoped, so it must launch where the session actually ran
// — not the herdr pane cwd corral snapshotted at bind time (the two diverge when the pane shell and
// the launched `claude` sat in different directories). Every message record carries `cwd`, so the
// tail read suffices. Returns null when no transcript is found or none of the tailed records carry a
// usable cwd; callers fall back to the stored cwdSnapshot.
export async function readSessionCwd(
  env: HerdrEnv,
  sessionId: string,
  exec?: ExecFn,
): Promise<string | null> {
  const transcriptPath = await findTranscript(env, sessionId, exec);
  if (transcriptPath === null) return null;

  let tail: string;
  try {
    tail = await readTail(env, transcriptPath, exec);
  } catch {
    return null;
  }
  const record = lastRecord(tail, (r) => typeof r.cwd === "string" && r.cwd !== "");
  return record !== null && typeof record.cwd === "string" ? record.cwd : null;
}

export async function readLastActivity(
  env: HerdrEnv,
  sessionId: string,
  exec?: ExecFn,
): Promise<number | null> {
  const transcriptPath = await findTranscript(env, sessionId, exec);
  if (transcriptPath === null) return null;

  let tail: string;
  try {
    tail = await readTail(env, transcriptPath, exec);
  } catch {
    tail = "";
  }
  const record = lastRecord(tail, (r) => typeof r.timestamp === "string");
  if (record !== null && typeof record.timestamp === "string") {
    const t = Date.parse(record.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  // Fallback: local file mtime (findTranscript already validated the path is inside a configDir).
  if (env.kind === "local") {
    try {
      const s = await stat(transcriptPath);
      return s.mtimeMs;
    } catch {
      return null;
    }
  }
  return null;
}
