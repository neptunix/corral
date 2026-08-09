import type { RegistryStatus } from "@shared/schema";
import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  CLAUDE_REGISTRY_MAX_BYTES, CLAUDE_REGISTRY_MAX_FILES, CLAUDE_REGISTRY_READ_TIMEOUT_MS,
} from "../config.ts";
import type { HerdrEnv } from "../environments.ts";
// SSH_NOISE is exported from herdr.ts — the ONE definition of "lines the ssh client wrote, not the
// remote command". A second copy here would drift the day one of them is extended.
import { defaultExec, type ExecFn, SSH_NOISE } from "./herdr.ts";

const SSH_FLAGS = ["-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes"];
// Mirrors statusline.ts: no shell metacharacter may reach the remote command string. The
// `/sessions/*.json` suffix is appended as a CONSTANT after this guard passes, so no glob character
// ever originates from configuration.
const SAFE_REMOTE_PATH_RE = /^[A-Za-z0-9~/._:@/-]+$/;
// The remote probe's "directory does not exist" exit code — distinct from every failure code, which is
// the whole point: `2>/dev/null || true` would turn a missing dir, a permissions error and a wrong
// path alike into exit 0 with empty output, i.e. indistinguishable from "no sessions".
const REMOTE_NO_DIR_EXIT = 3;

/**
 * One record in Claude Code's session registry. Files are named by PID and rewritten by the session on
 * every state change. EVERY optional field is `.nullable().optional()`: the bridge-state setter writes
 * `bridgeSessionId: null` on every Remote Control disconnect, and a plain `.optional()` would reject
 * the whole record the first time RC is turned off — dropping that session from the map entirely.
 */
export const RegistryRecordSchema = z.object({
  sessionId: z.string(),
  name: z.string().nullable().optional(),
  nameSource: z.string().nullable().optional(),
  status: z.string().nullable().optional(),          // idle | busy | waiting | shell
  waitingFor: z.string().nullable().optional(),      // why a `waiting` is waiting, e.g. "input needed"
  bridgeSessionId: z.string().nullable().optional(), // Remote Control — see remoteControlOf
  updatedAt: z.number().nullable().optional(),
});
export type RegistryRecord = z.infer<typeof RegistryRecordSchema>;

export interface RegistryRead {
  readonly records: readonly RegistryRecord[];
  readonly status: RegistryStatus;
  /** CLAUDE_REGISTRY_MAX_FILES or CLAUDE_REGISTRY_MAX_BYTES cut the read short — reported, never silent. */
  readonly truncated: boolean;
}

/**
 * The Remote Control tri-state, for a record that EXISTS. "No record at all" is unknown and stays the
 * caller's `null` — this function never sees that case. `updatedAt` cannot judge this field's
 * freshness: the bridge writer does not stamp it, so the mapping is purely structural. The obvious
 * `!== undefined` would read a DISCONNECTED session as connected, permanently.
 */
export function remoteControlOf(record: RegistryRecord): boolean {
  const id = record.bridgeSessionId;
  return id !== undefined && id !== null && id !== "";
}

/**
 * Resolve duplicate session ids — a stale dead-PID file beside the live one, which `--resume` produces
 * routinely — by greatest `updatedAt`, treating absent/null as 0 so a record without one never
 * outranks one with it. Exact ties keep the first read. This rule lives HERE and nowhere else.
 */
export function pickLatest(records: readonly RegistryRecord[]): Map<string, RegistryRecord> {
  const out = new Map<string, RegistryRecord>();
  for (const r of records) {
    const prev = out.get(r.sessionId);
    if (prev === undefined || (r.updatedAt ?? 0) > (prev.updatedAt ?? 0)) out.set(r.sessionId, r);
  }
  return out;
}

function parseRecords(texts: readonly string[]): { records: RegistryRecord[]; bad: number } {
  const records: RegistryRecord[] = [];
  let bad = 0;
  for (const text of texts) {
    if (text.trim() === "") continue;
    let json: unknown;
    try { json = JSON.parse(text); } catch { bad++; continue; }
    const parsed = RegistryRecordSchema.safeParse(json);
    if (parsed.success) records.push(parsed.data);
    else bad++;
  }
  return { records, bad };
}

/**
 * Read one `<config>/sessions` directory, in full. There is no partial-read mode: both callers — the
 * local interval and the remote sweep — read everything, which is what makes absence authoritative.
 * `caps` exists so the unit tests can drive truncation without mutating module state; production
 * callers pass nothing and get the config.ts values.
 */
export async function readRegistryDir(
  dir: string,
  caps?: { readonly maxFiles?: number; readonly maxBytes?: number },
): Promise<RegistryRead> {
  const maxFiles = caps?.maxFiles ?? CLAUDE_REGISTRY_MAX_FILES;
  const maxBytes = caps?.maxBytes ?? CLAUDE_REGISTRY_MAX_BYTES;
  const root = path.resolve(dir);
  let candidates: string[];
  try {
    candidates = (await readdir(root)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    // ENOENT is the normal case — Claude has never run under this config dir. Anything else (EACCES
    // above all) is a real failure and must not be reported as "never ran here", which would send an
    // operator looking for the wrong problem.
    const code = err !== null && typeof err === "object" && "code" in err ? err.code : null;
    return { records: [], status: code === "ENOENT" ? "not-found" : "read-error", truncated: false };
  }
  const truncatedByCount = candidates.length > maxFiles;
  let files = candidates;
  if (truncatedByCount) {
    // NEWEST FIRST, not filename order. Registry files are named by PID, which is unrelated to
    // liveness, and dead-session files are never cleaned up — so a filename-ordered cap on a machine
    // past the limit could read 200 dead sessions and none of the live ones. A stat per candidate is
    // cheap (no open, no read) and only happens on the path that is already over the cap.
    //
    // RESIDUAL, stated rather than paid for: this ordering guards the FILE cap only. Under the file cap
    // but over the BYTE cap, the loop below stops at whatever readdir happened to return first, so a
    // live session can lose its slot to a dead one. Reaching that needs ≤MAX_FILES files totalling
    // >MAX_BYTES — mean >1.3 KB against a measured 421 B — and it degrades honestly (the session reads
    // "not-found" → "state unavailable", plus the truncation warning), never as idle. Sorting
    // unconditionally would put MAX_FILES stat calls on every tick of a 3 s interval to serve a path
    // nothing has been observed on; a retry-once-sorted on truncatedByBytes is the fix if it ever is.
    const stamped = await Promise.all(candidates.map(async (f) => {
      try { return { f, mtime: (await stat(path.join(root, f))).mtimeMs }; } catch { return { f, mtime: 0 }; }
    }));
    stamped.sort((a, b) => b.mtime - a.mtime);
    files = stamped.slice(0, maxFiles).map((s) => s.f);
  }

  const texts: string[] = [];
  let budget = maxBytes;
  let truncatedByBytes = false;
  for (const f of files) {
    if (budget <= 0) { truncatedByBytes = true; break; }
    let fd;
    try {
      // O_NOFOLLOW: reject a symlink swapped in for a registry file. These files are written by
      // ANOTHER process, so following one would be an arbitrary-file read. Same guard as statusline.ts.
      fd = await open(path.join(root, f), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      continue; // removed between readdir and open, or a symlink — both normal, neither an error
    }
    try {
      const { size } = await fd.stat();
      if (size > budget) { truncatedByBytes = true; break; }
      const buf = Buffer.allocUnsafe(size);
      const { bytesRead } = await fd.read(buf, 0, size, 0);
      budget -= bytesRead;
      texts.push(buf.subarray(0, bytesRead).toString("utf8"));
    } catch {
      return { records: parseRecords(texts).records, status: "read-error", truncated: true };
    } finally {
      await fd.close();
    }
  }
  const { records, bad } = parseRecords(texts);
  return {
    records,
    status: bad > 0 ? "bad-schema" : "ok",
    truncated: truncatedByCount || truncatedByBytes,
  };
}

/** execFile surfaces a non-zero exit as `error.cause.code`; a spawn failure surfaces it as a string. */
function exitCodeOf(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const cause: unknown = err.cause;
  if (cause !== null && typeof cause === "object" && "code" in cause && typeof cause.code === "number") {
    return cause.code;
  }
  return null;
}

async function readRemoteDir(sshHost: string, configDir: string, exec: ExecFn): Promise<RegistryRead> {
  if (!SAFE_REMOTE_PATH_RE.test(configDir)) {
    return { records: [], status: "read-error", truncated: false };
  }
  // `test -d … || exit 3` first, so a missing directory is distinguishable from a failure and from
  // "no sessions". `awk 1` newline-terminates each file, yielding NDJSON — `cat` would fuse records,
  // which carry no trailing newline.
  //
  // The trailing `|| true` is load-bearing and was measured, not assumed: with the directory present
  // but holding no *.json, the glob does not expand, awk is handed a literal path, and the command
  // exits 2 — which without this would be reported as a read error for a perfectly healthy remote box
  // (verified: `sh -c 'test -d D || exit 3; awk 1 D/*.json 2>/dev/null'; echo $?` prints 2). The
  // missing-directory case still has its own exit 3 from the guard above, which is the distinction
  // that actually matters. The residual cost is stated: a per-file permission error also yields exit 0
  // with empty output, so it reads as "no sessions" rather than as an error — much rarer than an empty
  // directory, and the `test -d` covers the common permissions failure (the directory itself).
  const cmd = `test -d ${configDir}/sessions || exit ${String(REMOTE_NO_DIR_EXIT)}; awk 1 ${configDir}/sessions/*.json 2>/dev/null || true`;
  let stdout: string;
  try {
    ({ stdout } = await exec("ssh", [...SSH_FLAGS, sshHost, cmd], { timeout: CLAUDE_REGISTRY_READ_TIMEOUT_MS }));
  } catch (err) {
    // A timed-out read yields a READ ERROR, never zero records — the row must not read as "idle".
    return {
      records: [],
      status: exitCodeOf(err) === REMOTE_NO_DIR_EXIT ? "not-found" : "read-error",
      truncated: false,
    };
  }
  // STRIP SSH NOISE BEFORE PARSING. `bind:`/`channel_setup`/`Could not…`/`Warning: remote port…` lines
  // are written by the ssh client itself, not by the remote command — one of them in the stream is an
  // unparseable "record", which reports `bad-schema`: the drift detector for "Claude changed this file
  // format", fired on a completely healthy read.
  const clean = stdout.replace(SSH_NOISE, "");
  // NOTE: UTF-16 code units, not bytes — the local path caps on real byte sizes from fd.stat(), so a
  // registry holding non-ASCII session names lets this read up to ~3x the configured budget. The
  // direction is permissive (nothing truncates early), which is why it is recorded rather than fixed:
  // Buffer.byteLength here would also force the slice below onto a Buffer to stay consistent.
  const truncated = clean.length > CLAUDE_REGISTRY_MAX_BYTES;
  const lines = (truncated ? clean.slice(0, CLAUDE_REGISTRY_MAX_BYTES) : clean).split("\n");
  // Dropping the last line when truncated is what keeps `bad-schema` meaningful. The byte cap cuts the
  // NDJSON stream mid-record, so the tail is a partial JSON object that cannot parse — and `bad-schema`
  // is the DRIFT DETECTOR for "Claude changed this file format". Without this, a merely large registry
  // would eventually fire the format-change alarm on nothing at all.
  if (truncated) lines.pop();
  const { records, bad } = parseRecords(lines);
  return { records, status: bad > 0 ? "bad-schema" : "ok", truncated };
}

// Worst-first. A real failure must never be masked by the benign one: "not-found" is normal on a box
// where Claude has never run under that config dir, while "read-error" is always a genuine problem.
const WORSE: readonly RegistryStatus[] = ["read-error", "bad-schema", "not-found"];

/**
 * Every registry record for an environment. `records` is everything successfully read — possibly
 * non-empty even when `status` is not "ok", so one broken config dir cannot blank the healthy rows.
 * `status` is "ok" only when NO dir degraded, so partial visibility never reads as health.
 */
export async function readRegistry(env: HerdrEnv, exec?: ExecFn): Promise<RegistryRead> {
  if (env.claudeConfigDirs.length === 0) {
    return { records: [], status: "no-config-dirs", truncated: false };
  }
  const execFn = exec ?? defaultExec;
  const records: RegistryRecord[] = [];
  let worst: RegistryStatus | null = null;
  let truncated = false;
  for (const dir of env.claudeConfigDirs) {
    const res = env.kind === "local"
      ? await readRegistryDir(path.join(dir, "sessions"))
      : await readRemoteDir(env.sshHost, dir, execFn);
    records.push(...res.records);
    truncated = truncated || res.truncated;
    if (res.status !== "ok") {
      const rank = WORSE.indexOf(res.status);
      const currentRank = worst === null ? WORSE.length : WORSE.indexOf(worst);
      if (rank !== -1 && rank < currentRank) worst = res.status;
    }
  }
  return { records, status: worst ?? "ok", truncated };
}
