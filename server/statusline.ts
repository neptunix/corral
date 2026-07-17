import type { AccountUsage, SessionRow, StatuslineData, StatuslineStatus } from "@shared/schema";
import { StatuslineDataSchema } from "@shared/schema";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { STATUSLINE_MAX_BYTES, STATUSLINE_READ_TIMEOUT_MS } from "../config.ts";
import type { HerdrEnv } from "../environments.ts";
import { defaultExec, type ExecFn } from "./herdr.ts";

const SSH_FLAGS = ["-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes"];
// Mirrors transcript.ts: no shell metacharacters may reach the remote command string.
const SAFE_REMOTE_PATH_RE = /^[A-Za-z0-9~/._:@/-]+$/;
// session_id is used as a filename segment; match the capture script's charset guard.
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

interface Result {
  readonly data: StatuslineData | null;
  readonly status: StatuslineStatus;
}

function parseStatusline(text: string): Result {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { data: null, status: "read-error" };
  }
  const parsed = StatuslineDataSchema.safeParse(json);
  if (!parsed.success) return { data: null, status: "bad-schema" };
  return { data: parsed.data, status: "ok" };
}

async function readLocal(configDir: string, sessionId: string): Promise<Result> {
  const resolvedConfig = path.resolve(configDir);
  const filePath = path.join(resolvedConfig, "corral-status", `${sessionId}.json`);
  const prefix = resolvedConfig + path.sep + "corral-status" + path.sep;
  if (!path.resolve(filePath).startsWith(prefix)) return { data: null, status: "not-found" };
  let fd;
  try {
    // O_NOFOLLOW: reject a symlink swapped in for the status file (prevents reading arbitrary files).
    fd = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { data: null, status: "not-found" };
  }
  try {
    const { size } = await fd.stat();
    const length = Math.min(size, STATUSLINE_MAX_BYTES);
    if (length === 0) return { data: null, status: "read-error" };
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fd.read(buf, 0, length, 0);
    return parseStatusline(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return { data: null, status: "read-error" };
  } finally {
    await fd.close();
  }
}

async function readRemote(
  env: Extract<HerdrEnv, { kind: "remote" }>,
  configDir: string,
  sessionId: string,
  exec: ExecFn,
): Promise<Result> {
  const filePath = `${configDir}/corral-status/${sessionId}.json`;
  if (!SAFE_REMOTE_PATH_RE.test(filePath)) return { data: null, status: "not-found" };
  // `|| true`: a missing file yields empty stdout + exit 0 (→ not-found), not a rejected exec.
  const sshCmd = `cat ${filePath} 2>/dev/null || true`;
  try {
    const { stdout } = await exec("ssh", [...SSH_FLAGS, env.sshHost, sshCmd], { timeout: STATUSLINE_READ_TIMEOUT_MS });
    if (stdout.trim() === "") return { data: null, status: "not-found" };
    const body = stdout.length > STATUSLINE_MAX_BYTES ? stdout.slice(0, STATUSLINE_MAX_BYTES) : stdout;
    return parseStatusline(body);
  } catch {
    return { data: null, status: "read-error" };
  }
}

export async function readStatusline(env: HerdrEnv, sessionId: string, exec?: ExecFn): Promise<Result> {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) return { data: null, status: "not-found" };
  const execFn = exec ?? defaultExec;
  let lastStatus: StatuslineStatus = "not-found";
  for (const configDir of env.claudeConfigDirs) {
    const res = env.kind === "local"
      ? await readLocal(configDir, sessionId)
      : await readRemote(env, configDir, sessionId, execFn);
    if (res.status === "ok") return res;
    if (res.status !== "not-found") lastStatus = res.status;
  }
  return { data: null, status: lastStatus };
}

// Pure: group live rows by Claude account uuid; freshest capture wins its rate windows / identity,
// env ids are unioned. Account-global 5h/7d stay live while ANY session of the account is fresh.
export function aggregateAccounts(sessions: readonly SessionRow[]): AccountUsage[] {
  const byUuid = new Map<string, AccountUsage>();
  for (const s of sessions) {
    const sl = s.statusline;
    if (sl === null) continue;
    const acct = sl.account;
    if (acct === null) continue;
    if (acct.uuid === null) continue;
    const uuid = acct.uuid;
    const existing = byUuid.get(uuid);
    const envIds = existing === undefined
      ? [s.env]
      : (existing.envIds.includes(s.env) ? existing.envIds : [...existing.envIds, s.env]);
    if (existing === undefined || sl.captured_at > existing.capturedAt) {
      byUuid.set(uuid, {
        uuid, email: acct.email, org: acct.org, tier: acct.tier,
        fiveHour: sl.rate.five_hour, sevenDay: sl.rate.seven_day,
        capturedAt: sl.captured_at, envIds,
      });
    } else {
      byUuid.set(uuid, { ...existing, envIds });
    }
  }
  return [...byUuid.values()];
}
