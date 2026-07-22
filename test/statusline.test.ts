import type { SessionRow, StatuslineData } from "@shared/schema";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import type { ExecFn } from "../server/herdr.ts";
import { readStatusline, aggregateAccounts } from "../server/statusline.ts";

const SID = "a13ad559-8e59-4b98-b420-2746ef0b94d8";
const dirs: string[] = [];
afterEach(() => { while (dirs.length) { const d = dirs.pop(); if (d) rmSync(d, { recursive: true, force: true }); } });

function localEnv(configDirs: string[]): HerdrEnv {
  return { id: "l", label: "L", kind: "local", claudeConfigDirs: configDirs, spawnCommand: "claude", repos: {} };
}
function remoteEnv(configDirs: string[]): HerdrEnv {
  return { id: "r", label: "R", kind: "remote", sshHost: "h", socket: "~/s", herdrBin: "~/h", claudeConfigDirs: configDirs, spawnCommand: "claude", repos: {} };
}
const record: StatuslineData = {
  v: 1, captured_at: 100, session_id: SID, session_name: null, name_source: null,
  account: { uuid: "u1", email: "a@b.c", org: "O", tier: "t" },
  model: "Opus", model_id: null, ctx: { pct: 42, tokens: null, window: null },
  cost: { usd: null, lines_added: null, lines_removed: null },
  rate: { five_hour: { used_percentage: 31, resets_at: 9 }, seven_day: null },
  effort: null, thinking: null, cc_version: null,
};
function writeStatus(configDir: string, sid: string, body: string): void {
  const dir = path.join(configDir, "corral-status");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sid}.json`), body);
}
function tmp(): string { const d = mkdtempSync(path.join(os.tmpdir(), "corral-sl-")); dirs.push(d); return d; }

describe("readStatusline — local", () => {
  it("reads and validates a v1 file", async () => {
    const c = tmp(); writeStatus(c, SID, JSON.stringify(record));
    const r = await readStatusline(localEnv([c]), SID);
    expect(r.status).toBe("ok");
    expect(r.data?.ctx.pct).toBe(42);
  });

  it("returns not-found when the file is absent", async () => {
    const r = await readStatusline(localEnv([tmp()]), SID);
    expect(r.status).toBe("not-found");
  });

  it("returns bad-schema for a wrong version", async () => {
    const c = tmp(); writeStatus(c, SID, JSON.stringify({ ...record, v: 2 }));
    expect((await readStatusline(localEnv([c]), SID)).status).toBe("bad-schema");
  });

  it("returns read-error for malformed JSON", async () => {
    const c = tmp(); writeStatus(c, SID, "{not json");
    expect((await readStatusline(localEnv([c]), SID)).status).toBe("read-error");
  });

  it("rejects a symlinked status file (O_NOFOLLOW)", async () => {
    const c = tmp(); const dir = path.join(c, "corral-status"); mkdirSync(dir, { recursive: true });
    const secret = path.join(c, "secret.json"); writeFileSync(secret, JSON.stringify(record));
    symlinkSync(secret, path.join(dir, `${SID}.json`));
    expect((await readStatusline(localEnv([c]), SID)).status).toBe("not-found");
  });

  it("rejects a session id containing path separators", async () => {
    expect((await readStatusline(localEnv([tmp()]), "../../etc/passwd")).status).toBe("not-found");
  });
});

describe("readStatusline — remote", () => {
  it("cats the file over ssh and parses it", async () => {
    const exec: ExecFn = vi.fn().mockResolvedValue({ stdout: JSON.stringify(record), stderr: "" });
    const r = await readStatusline(remoteEnv(["/r/.claude"]), SID, exec);
    expect(r.status).toBe("ok");
    const call = (exec as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call?.[0]).toBe("ssh");
    expect(JSON.stringify(call?.[1])).toContain("/r/.claude/corral-status/" + SID + ".json");
  });

  it("treats empty ssh output as not-found", async () => {
    const exec: ExecFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    expect((await readStatusline(remoteEnv(["/r/.claude"]), SID, exec)).status).toBe("not-found");
  });
});

describe("aggregateAccounts", () => {
  const rowWith = (env: string, uuid: string, capturedAt: number, pct: number): SessionRow => ({
    env, paneId: "p", status: "working", agent: "a", cwd: "/c", tab: "t", workspace: "w",
    sessionId: "sid", recap: null, recapAt: null, recapStatus: null,
    statusline: { ...record, captured_at: capturedAt, account: { uuid, email: "a@b.c", org: "O", tier: "t" },
      rate: { five_hour: { used_percentage: pct, resets_at: 9 }, seven_day: null } },
    statuslineStatus: "ok",
  });

  it("groups by account uuid, freshest capture wins, unions envs", () => {
    const out = aggregateAccounts([rowWith("e1", "u1", 100, 10), rowWith("e2", "u1", 200, 55)]);
    expect(out).toHaveLength(1);
    expect(out[0]?.fiveHour?.used_percentage).toBe(55);
    expect(out[0]?.capturedAt).toBe(200);
    expect(out[0]?.envIds.sort()).toEqual(["e1", "e2"]);
  });

  it("skips sessions without an account uuid", () => {
    const noAcct: SessionRow = { ...rowWith("e", "x", 1, 1), statusline: null };
    expect(aggregateAccounts([noAcct])).toEqual([]);
  });
});
