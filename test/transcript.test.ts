import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";

import { RECAP_CONTENT_MAX, RECAP_TAIL_BYTES } from "../config.ts";
import type { HerdrEnv } from "../environments.ts";
import type { ExecFn } from "../server/herdr.ts";
import { findTranscript, lastRecord, readLastActivity, readRecap, readSessionCwd, readTail } from "../server/transcript.ts";

const VALID_UUID = "a13ad559-8e59-4b98-b420-2746ef0b94d8";

const fixtureDirs: string[] = [];

afterEach(() => {
  while (fixtureDirs.length > 0) {
    const dir = fixtureDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "corral-tr-"));
}

function writeTranscript(configDir: string, sessionId: string, lines: string[]): string {
  const projectsDir = path.join(configDir, "projects");
  const subDir = mkdtempSync(path.join(projectsDir, "proj-"));
  const file = path.join(subDir, `${sessionId}.jsonl`);
  writeFileSync(file, lines.join("\n"));
  return file;
}

function makeLocalEnv(configDirs: string[]): HerdrEnv {
  return { id: "l", label: "L", kind: "local", claudeConfigDirs: configDirs, spawnCommand: "claude", repos: {} };
}
function makeRemoteEnv(configDirs: string[]): HerdrEnv {
  return { id: "r", label: "R", kind: "remote", sshHost: "myhost", socket: "~/s.sock", herdrBin: "~/h", claudeConfigDirs: configDirs, spawnCommand: "claude", repos: {} };
}

function writeTranscriptFixture(
  records: readonly Record<string, unknown>[],
): { env: HerdrEnv; sessionId: string } {
  const configDir = makeTmpDir();
  fixtureDirs.push(configDir);
  mkdirSync(path.join(configDir, "projects"), { recursive: true });
  const sessionId = randomUUID();
  if (records.length > 0) {
    writeTranscript(configDir, sessionId, records.map((r) => JSON.stringify(r)));
  }
  return { env: makeLocalEnv([configDir]), sessionId };
}

// ---- findTranscript (local) ----

describe("findTranscript — local", () => {
  it("finds transcript by UUID glob", async () => {
    const configDir = makeTmpDir();
    mkdirSync(path.join(configDir, "projects"), { recursive: true });
    const file = writeTranscript(configDir, VALID_UUID, ['{"type":"system"}']);
    const result = await findTranscript(makeLocalEnv([configDir]), VALID_UUID);
    expect(result).toBe(file);
  });

  it("returns null when transcript not found", async () => {
    const configDir = makeTmpDir();
    mkdirSync(path.join(configDir, "projects"), { recursive: true });
    const result = await findTranscript(makeLocalEnv([configDir]), VALID_UUID);
    expect(result).toBeNull();
  });

  it("returns null when projects dir does not exist", async () => {
    const configDir = makeTmpDir();
    const result = await findTranscript(makeLocalEnv([configDir]), VALID_UUID);
    expect(result).toBeNull();
  });

  it("searches multiple claudeConfigDirs in order", async () => {
    const configDir1 = makeTmpDir();
    mkdirSync(path.join(configDir1, "projects"), { recursive: true });
    const configDir2 = makeTmpDir();
    mkdirSync(path.join(configDir2, "projects"), { recursive: true });
    const file = writeTranscript(configDir2, VALID_UUID, ['{"type":"system"}']);
    const result = await findTranscript(makeLocalEnv([configDir1, configDir2]), VALID_UUID);
    expect(result).toBe(file);
  });

  it(">1 match across project dirs: picks newest by mtime", async () => {
    const { utimesSync } = await import("node:fs");
    const configDir = makeTmpDir();
    mkdirSync(path.join(configDir, "projects"), { recursive: true });
    const file1 = writeTranscript(configDir, VALID_UUID, ['{"type":"old"}']);
    const file2 = writeTranscript(configDir, VALID_UUID, ['{"type":"new"}']);
    const oldTime = new Date(Date.now() - 60000);
    utimesSync(file1, oldTime, oldTime);
    const result = await findTranscript(makeLocalEnv([configDir]), VALID_UUID);
    expect(result).toBe(file2);
  });
});

// ---- findTranscript (remote) ----

describe("findTranscript — remote", () => {
  it("calls ssh ls with ConnectTimeout=8 and StrictHostKeyChecking=yes", async () => {
    const returnedPath = `/remote/.claude/projects/d/${VALID_UUID}.jsonl`;
    const exec: ExecFn = vi.fn(() => Promise.resolve({ stdout: returnedPath + "\n", stderr: "" }));
    const result = await findTranscript(makeRemoteEnv(["/remote/.claude"]), VALID_UUID, exec);
    expect(result).toBe(returnedPath);
    const calls = (exec as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], unknown];
    expect(calls[0]).toBe("ssh");
    const args = calls[1];
    expect(args).toContain("ConnectTimeout=8");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("myhost");
    const cmd = args[args.length - 1]!;
    expect(cmd).toContain(VALID_UUID);
  });

  it("returns null when ls returns empty", async () => {
    const exec: ExecFn = vi.fn(() => Promise.resolve({ stdout: "", stderr: "" }));
    const result = await findTranscript(makeRemoteEnv(["/remote/.claude"]), VALID_UUID, exec);
    expect(result).toBeNull();
  });

  it("returns null on ssh error", async () => {
    const exec: ExecFn = vi.fn(() => Promise.reject(new Error("ssh timeout")));
    const result = await findTranscript(makeRemoteEnv(["/remote/.claude"]), VALID_UUID, exec);
    expect(result).toBeNull();
  });
});

// ---- readTail (local) ----

describe("readTail — local", () => {
  it("returns the full file when smaller than RECAP_TAIL_BYTES", async () => {
    const configDir = makeTmpDir();
    mkdirSync(path.join(configDir, "projects"), { recursive: true });
    const file = writeTranscript(configDir, VALID_UUID, ['{"type":"a"}', '{"type":"b"}']);
    const tail = await readTail(makeLocalEnv([configDir]), file);
    expect(tail).toContain('"type":"a"');
    expect(tail).toContain('"type":"b"');
  });

  it("discards a partial leading line when reading from mid-file", async () => {
    const configDir = makeTmpDir();
    mkdirSync(path.join(configDir, "projects"), { recursive: true });
    const bigLine = JSON.stringify({ type: "x", data: "a".repeat(RECAP_TAIL_BYTES + 100) });
    const completeLine = '{"type":"z","complete":true}';
    const file = writeTranscript(configDir, VALID_UUID, [bigLine, completeLine]);
    const result = await readTail(makeLocalEnv([configDir]), file);
    expect(result).toContain('"type":"z"');
  });

  it("rejects a symlink (O_NOFOLLOW)", async () => {
    const configDir = makeTmpDir();
    mkdirSync(path.join(configDir, "projects", "proj"), { recursive: true });
    const real = path.join(configDir, "real.jsonl");
    writeFileSync(real, '{"type":"system"}');
    const link = path.join(configDir, "projects", "proj", `${VALID_UUID}.jsonl`);
    symlinkSync(real, link);
    await expect(readTail(makeLocalEnv([configDir]), link)).rejects.toThrow();
  });
});

// ---- readTail (remote) ----

describe("readTail — remote", () => {
  it("calls ssh tail -c RECAP_TAIL_BYTES with StrictHostKeyChecking=yes", async () => {
    const exec: ExecFn = vi.fn(() => Promise.resolve({ stdout: '{"type":"system"}\n', stderr: "" }));
    await readTail(makeRemoteEnv(["/remote/.claude"]), "/remote/.claude/projects/d/sess.jsonl", exec);
    const calls = (exec as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], unknown];
    expect(calls[0]).toBe("ssh");
    const args = calls[1];
    expect(args).toContain("StrictHostKeyChecking=yes");
    const cmd = args[args.length - 1]!;
    expect(cmd).toContain("tail -c");
    expect(cmd).toContain(String(RECAP_TAIL_BYTES));
  });

  it("caps output to RECAP_TAIL_BYTES characters", async () => {
    const oversize = "x".repeat(RECAP_TAIL_BYTES + 500);
    const exec: ExecFn = vi.fn(() => Promise.resolve({ stdout: oversize, stderr: "" }));
    const result = await readTail(makeRemoteEnv(["/remote/.claude"]), "/p/f.jsonl", exec);
    expect(result.length).toBeLessThanOrEqual(RECAP_TAIL_BYTES);
  });
});

// ---- path safety ----

describe("path safety", () => {
  it("readTail rejects a path outside configDir/projects/", async () => {
    const configDir = makeTmpDir();
    const outsideFile = path.join(configDir, `${VALID_UUID}.jsonl`);
    writeFileSync(outsideFile, '{"type":"system","subtype":"away_summary","content":"evil"}');
    await expect(readTail(makeLocalEnv([configDir]), outsideFile)).rejects.toThrow(/outside/);
  });
});

// ---- lastRecord ----

describe("lastRecord", () => {
  const awayPred = (r: Record<string, unknown>): boolean =>
    r.type === "system" && r.subtype === "away_summary";

  it("returns the last matching record", () => {
    const tail = [
      '{"type":"system","subtype":"away_summary","content":"first"}',
      '{"type":"user","content":"hi"}',
      '{"type":"system","subtype":"away_summary","content":"last"}',
      '{"type":"user","content":"bye"}',
    ].join("\n");
    const r = lastRecord(tail, awayPred);
    expect(r?.content).toBe("last");
  });

  it("returns null when no record matches", () => {
    const tail = '{"type":"user","content":"hi"}\n{"type":"assistant","content":"hello"}';
    expect(lastRecord(tail, awayPred)).toBeNull();
  });

  it("skips non-JSON lines", () => {
    const tail = "not json\n{bad json\n" + '{"type":"system","subtype":"away_summary","content":"ok"}';
    expect(lastRecord(tail, awayPred)?.content).toBe("ok");
  });

  it("skips JSON non-objects (arrays, primitives)", () => {
    const tail = '[1,2,3]\n42\n"string"\n{"type":"system","subtype":"away_summary","content":"ok"}';
    expect(lastRecord(tail, awayPred)?.content).toBe("ok");
  });

  it("returns null for empty tail", () => {
    expect(lastRecord("", awayPred)).toBeNull();
  });

  it("handles a truncated partial JSON line at start", () => {
    const tail = 'artial json}\n{"type":"system","subtype":"away_summary","content":"valid"}';
    expect(lastRecord(tail, awayPred)?.content).toBe("valid");
  });
});

// ---- readRecap ----

describe("readRecap", () => {
  it("returns ok status and recap content on full success", async () => {
    const configDir = makeTmpDir();
    mkdirSync(path.join(configDir, "projects"), { recursive: true });
    writeTranscript(configDir, VALID_UUID, [
      '{"type":"user","content":"hello"}',
      '{"type":"system","subtype":"away_summary","content":"Working on recap capture."}',
    ]);
    const { recap, status } = await readRecap(makeLocalEnv([configDir]), VALID_UUID);
    expect(status).toBe("ok");
    expect(recap).toBe("Working on recap capture.");
  });

  it("returns not-found when no transcript file exists", async () => {
    const configDir = makeTmpDir();
    mkdirSync(path.join(configDir, "projects"), { recursive: true });
    const { recap, status } = await readRecap(makeLocalEnv([configDir]), VALID_UUID);
    expect(status).toBe("not-found");
    expect(recap).toBeNull();
  });

  it("returns no-summary when transcript has no away_summary record", async () => {
    const configDir = makeTmpDir();
    mkdirSync(path.join(configDir, "projects"), { recursive: true });
    writeTranscript(configDir, VALID_UUID, ['{"type":"user","content":"hello"}']);
    const { recap, status } = await readRecap(makeLocalEnv([configDir]), VALID_UUID);
    expect(status).toBe("no-summary");
    expect(recap).toBeNull();
  });

  it("returns read-error when the exec for remote ssh throws", async () => {
    const exec: ExecFn = vi.fn(() => Promise.reject(new Error("ssh fail")));
    const { recap, status } = await readRecap(makeRemoteEnv(["/r/.claude"]), VALID_UUID, exec);
    expect(["not-found", "read-error"]).toContain(status);
    expect(recap).toBeNull();
  });

  it("caps recap content to RECAP_CONTENT_MAX chars", async () => {
    const configDir = makeTmpDir();
    mkdirSync(path.join(configDir, "projects"), { recursive: true });
    const longContent = "x".repeat(RECAP_CONTENT_MAX + 500);
    writeTranscript(configDir, VALID_UUID, [
      `{"type":"system","subtype":"away_summary","content":${JSON.stringify(longContent)}}`,
    ]);
    const { recap, status } = await readRecap(makeLocalEnv([configDir]), VALID_UUID);
    expect(status).toBe("ok");
    expect(recap?.length).toBe(RECAP_CONTENT_MAX);
  });

  it("handles non-ASCII (Japanese) recap content", async () => {
    const configDir = makeTmpDir();
    mkdirSync(path.join(configDir, "projects"), { recursive: true });
    const content = "バグを修正中: WebSocket接続が切れる問題";
    writeTranscript(configDir, VALID_UUID, [
      `{"type":"system","subtype":"away_summary","content":${JSON.stringify(content)}}`,
    ]);
    const { recap } = await readRecap(makeLocalEnv([configDir]), VALID_UUID);
    expect(recap).toBe(content);
  });
});

// ---- readLastActivity ----

describe("readLastActivity", () => {
  it("returns the last record's timestamp in ms", async () => {
    // Arrange: write a transcript whose last line has timestamp "2026-07-11T10:00:00.000Z"
    const { env, sessionId } = writeTranscriptFixture([
      { type: "user", timestamp: "2026-07-11T09:00:00.000Z" },
      { type: "assistant", timestamp: "2026-07-11T10:00:00.000Z" },
    ]);
    const ms = await readLastActivity(env, sessionId);
    expect(ms).toBe(Date.parse("2026-07-11T10:00:00.000Z"));
  });

  it("returns null when no transcript exists", async () => {
    const { env } = writeTranscriptFixture([]);
    expect(await readLastActivity(env, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

// ---- readSessionCwd ----
// The authoritative cwd for `claude --resume <uuid>` is the one recorded in the session's own
// transcript — NOT the herdr pane cwd corral snapshotted at bind time (they diverge when the pane
// shell and the launched `claude` sat in different directories). See the resume-cwd regression.

describe("readSessionCwd", () => {
  it("returns the cwd recorded in the transcript", async () => {
    const { env, sessionId } = writeTranscriptFixture([
      { type: "user", cwd: "/Users/x/Developer/proj", timestamp: "2026-07-11T09:00:00.000Z" },
      { type: "assistant", cwd: "/Users/x/Developer/proj", timestamp: "2026-07-11T10:00:00.000Z" },
    ]);
    expect(await readSessionCwd(env, sessionId)).toBe("/Users/x/Developer/proj");
  });

  it("returns null when no transcript exists", async () => {
    const { env } = writeTranscriptFixture([]);
    expect(await readSessionCwd(env, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("returns null when transcript records carry no cwd", async () => {
    const { env, sessionId } = writeTranscriptFixture([{ type: "system", subtype: "init" }]);
    expect(await readSessionCwd(env, sessionId)).toBeNull();
  });

  it("returns null when the transcript read fails (remote read rejects)", async () => {
    // findTranscript succeeds (the `ls` resolves) but the tail read throws. readSessionCwd must
    // swallow it and return null — the resume endpoint awaits this OUTSIDE its try/catch, so a throw
    // here would 500 instead of falling back to cwdSnapshot.
    const found = `/remote/.claude/projects/d/${VALID_UUID}.jsonl`;
    const exec: ExecFn = vi.fn((_file: string, args: readonly string[]) => {
      const sshCmd = args[args.length - 1] ?? "";
      return sshCmd.includes("tail -c")
        ? Promise.reject(new Error("ssh read failed"))
        : Promise.resolve({ stdout: found + "\n", stderr: "" });
    });
    expect(await readSessionCwd(makeRemoteEnv(["/remote/.claude"]), VALID_UUID, exec)).toBeNull();
  });

  it("skips a record whose cwd is empty and falls back to an earlier valid cwd", async () => {
    // Guards the `r.cwd !== ""` predicate: without it the empty-cwd last record would be returned as
    // "", which is non-null and so bypasses the endpoint's `?? cwdSnapshot` fallback.
    const { env, sessionId } = writeTranscriptFixture([
      { type: "user", cwd: "/real/dir" },
      { type: "assistant", cwd: "" },
    ]);
    expect(await readSessionCwd(env, sessionId)).toBe("/real/dir");
  });
});
