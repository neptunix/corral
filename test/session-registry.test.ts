import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CLAUDE_REGISTRY_MAX_BYTES } from "../config.ts";
import type { HerdrEnv } from "../environments.ts";
import type { ExecFn } from "../server/herdr.ts";
import {
  pickLatest, readRegistry, readRegistryDir, remoteControlOf,
} from "../server/session-registry.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length > 0) { const d = dirs.pop(); if (d !== undefined) rmSync(d, { recursive: true, force: true }); } });

/** A config dir with a `sessions/` subdirectory holding the given files. Returns the CONFIG dir. */
function configDir(files: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "corral-reg-"));
  dirs.push(root);
  mkdirSync(path.join(root, "sessions"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(root, "sessions", name), typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

const localEnv = (claudeConfigDirs: readonly string[]): HerdrEnv =>
  ({ id: "l", label: "L", kind: "local", claudeConfigDirs, spawnCommand: "claude", repos: {} });
const remoteEnv = (claudeConfigDirs: readonly string[]): HerdrEnv =>
  ({ id: "r", label: "R", kind: "remote", sshHost: "box", socket: "/s", herdrBin: "herdr", claudeConfigDirs, spawnCommand: "claude", repos: {} });

describe("readRegistryDir", () => {
  it("reads every *.json and ignores anything else", async () => {
    const cfg = configDir({
      "1.json": { sessionId: "s1", status: "idle" },
      "2.json": { sessionId: "s2", status: "busy" },
      "notes.txt": "ignored",
    });
    const out = await readRegistryDir(path.join(cfg, "sessions"));
    expect(out.status).toBe("ok");
    expect(out.records.map((r) => r.sessionId).sort()).toEqual(["s1", "s2"]);
    // A healthy read must say so. Without this, `truncated` could be hard-coded true and the two
    // truncation tests below would still pass.
    expect(out.truncated).toBe(false);
  });

  // The bridge writer stores a LITERAL null on every disconnect. `z.string().optional()` would reject
  // the whole record the first time Remote Control is turned off, dropping that session from the map.
  it("accepts a literal null in every optional field", async () => {
    const cfg = configDir({
      "1.json": { sessionId: "s1", name: null, nameSource: null, status: null, waitingFor: null, bridgeSessionId: null, updatedAt: null },
    });
    const out = await readRegistryDir(path.join(cfg, "sessions"));
    expect(out.status).toBe("ok");
    expect(out.records).toHaveLength(1);
    expect(out.records[0]?.bridgeSessionId).toBeNull();
  });

  it("reports not-found for a missing directory rather than an empty success", async () => {
    const out = await readRegistryDir(path.join(os.tmpdir(), "corral-reg-does-not-exist"));
    expect(out.status).toBe("not-found");
    expect(out.records).toEqual([]);
  });

  it("reports ok with zero records for an existing but empty directory", async () => {
    const out = await readRegistryDir(path.join(configDir({}), "sessions"));
    expect(out.status).toBe("ok");
    expect(out.records).toEqual([]);
  });

  // The drift detector: a Claude release that changes this undocumented format must SAY so.
  it("reports bad-schema when a file parses as JSON but not as a record", async () => {
    const cfg = configDir({ "1.json": { notASessionId: true } });
    const out = await readRegistryDir(path.join(cfg, "sessions"));
    expect(out.status).toBe("bad-schema");
  });

  it("reports bad-schema for a file that is not JSON at all", async () => {
    const cfg = configDir({ "1.json": "not json {{{" });
    const out = await readRegistryDir(path.join(cfg, "sessions"));
    expect(out.status).toBe("bad-schema");
  });

  it("keeps the good records alongside a bad-schema report", async () => {
    const cfg = configDir({ "1.json": { sessionId: "s1" }, "2.json": { nope: 1 } });
    const out = await readRegistryDir(path.join(cfg, "sessions"));
    expect(out.status).toBe("bad-schema");
    expect(out.records.map((r) => r.sessionId)).toEqual(["s1"]);
  });

  // An empty file is what a half-written registry entry looks like for a few microseconds. It is not
  // a format change, so it must NOT fire the drift detector.
  it("skips an empty file without reporting bad-schema", async () => {
    const cfg = configDir({ "1.json": { sessionId: "s1" }, "2.json": "" });
    const out = await readRegistryDir(path.join(cfg, "sessions"));
    expect(out.status).toBe("ok");
    expect(out.records.map((r) => r.sessionId)).toEqual(["s1"]);
  });

  // O_NOFOLLOW, matching the deliberate symlink guard in statusline.ts: these files are written by
  // another process, so a swapped-in symlink must not become an arbitrary-file read.
  it("refuses to follow a symlink standing in for a registry file", async () => {
    const cfg = configDir({ "1.json": { sessionId: "s1" } });
    const secret = path.join(cfg, "secret.json");
    writeFileSync(secret, JSON.stringify({ sessionId: "leaked" }));
    symlinkSync(secret, path.join(cfg, "sessions", "2.json"));
    const out = await readRegistryDir(path.join(cfg, "sessions"));
    expect(out.records.map((r) => r.sessionId)).toEqual(["s1"]);
    // A skipped symlink is not a format change either — `bad-schema` here would be a false alarm.
    expect(out.status).toBe("ok");
  });

  it("reports read-error, not not-found, when the path exists but cannot be listed", async () => {
    // ENOTDIR rather than ENOENT. "not-found" means "Claude has never run here" and is normal; every
    // other failure is real and must not be disguised as the normal case.
    const cfg = configDir({ "1.json": { sessionId: "s1" } });
    const out = await readRegistryDir(path.join(cfg, "sessions", "1.json"));
    expect(out.status).toBe("read-error");
  });

  // Registry files are named by PID, which says nothing about liveness, and dead-session files are
  // never cleaned up. A filename-ordered cap on a machine past the limit could read 200 dead sessions
  // and none of the live ones — so the cap must keep the NEWEST.
  it("keeps the newest files when the count cap truncates, and says it truncated", async () => {
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) files[`${String(i)}.json`] = { sessionId: `s${String(i)}` };
    const cfg = configDir(files);
    // Explicit mtimes — five files written in a loop can share a timestamp, and a flaky ordering test
    // is worse than no ordering test.
    for (let i = 0; i < 5; i++) {
      const t = new Date(1_700_000_000_000 + i * 60_000);
      utimesSync(path.join(cfg, "sessions", `${String(i)}.json`), t, t);
    }
    // TWO arguments. `readRegistryDir(dir, undefined, caps)` is revision 4's deleted `names` slot.
    const out = await readRegistryDir(path.join(cfg, "sessions"), { maxFiles: 2 });
    expect(out.truncated).toBe(true);
    expect(out.records.map((r) => r.sessionId).sort()).toEqual(["s3", "s4"]);
  });

  // Exactly AT the cap is not over it. Off-by-one here would pay for a stat() of every candidate on
  // every tick of a directory that never needed sorting.
  it("does not truncate when the file count equals the cap", async () => {
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 3; i++) files[`${String(i)}.json`] = { sessionId: `s${String(i)}` };
    const out = await readRegistryDir(path.join(configDir(files), "sessions"), { maxFiles: 3 });
    expect(out.truncated).toBe(false);
    expect(out.records.map((r) => r.sessionId).sort()).toEqual(["s0", "s1", "s2"]);
  });

  it("stops at the byte cap and reports the truncation", async () => {
    const body = JSON.stringify({ sessionId: "s0" }); // both files are this exact length
    const cfg = configDir({ "1.json": body, "2.json": { sessionId: "s1" } });
    // Room for one record and no more. Which of the two survives is readdir order and is NOT asserted;
    // that it stopped after one, and said so, is the behaviour.
    const out = await readRegistryDir(path.join(cfg, "sessions"), { maxBytes: body.length });
    expect(out.truncated).toBe(true);
    expect(out.records).toHaveLength(1);
    // A byte-capped read is not a malformed one.
    expect(out.status).toBe("ok");
  });
});

describe("pickLatest — the duplicate-sessionId rule", () => {
  // A stale dead-PID file beside the live one is what `--resume` produces routinely.
  it("keeps the record with the greatest updatedAt", () => {
    const m = pickLatest([
      { sessionId: "s1", status: "idle", updatedAt: 100 },
      { sessionId: "s1", status: "waiting", waitingFor: "input needed", updatedAt: 200 },
    ]);
    expect(m.get("s1")?.status).toBe("waiting");
  });

  it("keeps the greatest updatedAt regardless of input order", () => {
    const m = pickLatest([
      { sessionId: "s1", status: "waiting", updatedAt: 200 },
      { sessionId: "s1", status: "idle", updatedAt: 100 },
    ]);
    expect(m.get("s1")?.status).toBe("waiting");
  });

  it("treats an absent or null updatedAt as 0, so it never outranks one that has it", () => {
    expect(pickLatest([
      { sessionId: "s1", status: "fresh", updatedAt: 5 },
      { sessionId: "s1", status: "stale" },
      { sessionId: "s1", status: "also-stale", updatedAt: null },
    ]).get("s1")?.status).toBe("fresh");
  });

  it("keeps the first on an exact tie", () => {
    expect(pickLatest([
      { sessionId: "s1", status: "first", updatedAt: 7 },
      { sessionId: "s1", status: "second", updatedAt: 7 },
    ]).get("s1")?.status).toBe("first");
  });

  it("keys distinct sessions separately", () => {
    const m = pickLatest([{ sessionId: "s1", status: "a" }, { sessionId: "s2", status: "b" }]);
    expect(m.get("s1")?.status).toBe("a");
    expect(m.get("s2")?.status).toBe("b");
    expect(m.size).toBe(2);
  });
});

// D.1. `updatedAt` cannot judge this field's freshness — the bridge writer does not stamp it — so the
// mapping is purely structural, and the obvious `!== undefined` would read a DISCONNECTED session as
// connected and hide the enable button for it permanently.
describe("remoteControlOf", () => {
  it("is true for a non-empty bridgeSessionId", () => {
    expect(remoteControlOf({ sessionId: "s", bridgeSessionId: "session_01ABC" })).toBe(true);
  });
  it("is false for a literal null — explicitly disconnected", () => {
    expect(remoteControlOf({ sessionId: "s", bridgeSessionId: null })).toBe(false);
  });
  it("is false when the field is absent — never connected in this session's lifetime", () => {
    expect(remoteControlOf({ sessionId: "s" })).toBe(false);
  });
  it("is false for an empty string", () => {
    expect(remoteControlOf({ sessionId: "s", bridgeSessionId: "" })).toBe(false);
  });
});

describe("readRegistry", () => {
  it("reports no-config-dirs when the environment has none", async () => {
    const out = await readRegistry(localEnv([]));
    expect(out.status).toBe("no-config-dirs");
    expect(out.records).toEqual([]);
  });

  // The DEFAULT on every remote environment, and the reason no-config-dirs falls back to the herdr
  // status instead of rendering as a degraded read (operator ruling, round 1 #2).
  it("reports no-config-dirs for a remote environment with none, without exec'ing", async () => {
    let called = false;
    const exec: ExecFn = () => { called = true; return Promise.resolve({ stdout: "", stderr: "" }); };
    expect((await readRegistry(remoteEnv([]), exec)).status).toBe("no-config-dirs");
    expect(called).toBe(false);
  });

  it("reads every config dir of a local environment", async () => {
    const a = configDir({ "1.json": { sessionId: "s1" } });
    const b = configDir({ "2.json": { sessionId: "s2" } });
    const out = await readRegistry(localEnv([a, b]));
    expect(out.status).toBe("ok");
    expect(out.records.map((r) => r.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  // Partial visibility must not read as health, but the records that WERE read are still returned.
  it("surfaces a read error while keeping the records it did get", async () => {
    const good = configDir({ "1.json": { sessionId: "s1" } });
    const out = await readRegistry(localEnv([good, path.join(os.tmpdir(), "corral-reg-nope")]));
    expect(out.records.map((r) => r.sessionId)).toEqual(["s1"]);
    expect(out.status).toBe("not-found"); // one dir has no sessions/ — normal, and NOT reported as ok
  });

  // The ranking exists so a real failure is never masked by the benign one. Without it the reported
  // status would be whichever dir happened to be read last.
  it("reports the worst status across dirs — read-error outranks not-found", async () => {
    const broken = configDir({ "1.json": { sessionId: "s1" } });
    const out = await readRegistry(localEnv([
      path.join(broken, "sessions", "1.json"), // ENOTDIR -> read-error
      path.join(os.tmpdir(), "corral-reg-nope"), // ENOENT  -> not-found
    ]));
    expect(out.status).toBe("read-error");
  });

  it("reports bad-schema over not-found, and read-error over bad-schema", async () => {
    const malformed = configDir({ "1.json": { nope: 1 } });
    expect((await readRegistry(localEnv([
      malformed, path.join(os.tmpdir(), "corral-reg-nope"),
    ]))).status).toBe("bad-schema");

    const broken = configDir({ "1.json": { sessionId: "s1" } });
    expect((await readRegistry(localEnv([
      malformed, path.join(broken, "sessions", "1.json"),
    ]))).status).toBe("read-error");
  });

  it("reads a remote environment with one ssh call per config dir", async () => {
    let seen: readonly string[] = [];
    const exec: ExecFn = (_file, args) => {
      seen = args;
      return Promise.resolve({
        stdout: `${JSON.stringify({ sessionId: "s1", bridgeSessionId: "session_01X" })}\n`,
        stderr: "",
      });
    };
    const out = await readRegistry(remoteEnv(["/home/u/.claude"]), exec);
    const cmd = seen[seen.length - 1] ?? "";
    // `test -d … || exit 3` is what makes "directory absent" distinguishable from "no sessions";
    // `awk 1` newline-terminates each file (registry files carry none), so `cat` would fuse records.
    expect(cmd).toContain("test -d /home/u/.claude/sessions || exit 3");
    expect(cmd).toContain("awk 1 /home/u/.claude/sessions/*.json");
    // MEASURED, not assumed: with the directory present but holding no *.json the glob does not
    // expand, awk gets a literal path, and the command exits 2. Without `|| true` a healthy remote box
    // with no live sessions reports as unreadable — every row "state unavailable".
    // Reproduce with: sh -c 'test -d D || exit 3; awk 1 D/*.json 2>/dev/null'; echo $?   → 2
    expect(cmd).toContain("|| true");
    expect(out.status).toBe("ok");
    expect(out.records[0]?.bridgeSessionId).toBe("session_01X");
  });

  it("makes exactly one ssh call per remote config dir", async () => {
    let calls = 0;
    const exec: ExecFn = () => { calls += 1; return Promise.resolve({ stdout: "", stderr: "" }); };
    await readRegistry(remoteEnv(["/home/u/.claude", "/home/u/.claude-alt"]), exec);
    expect(calls).toBe(2);
  });

  // SSH writes its own chatter onto the same stream as the remote command's output. Unstripped, one
  // such line is an unparseable record and the read reports `bad-schema` — the drift detector for
  // "Claude changed this file format" — on a completely healthy box. Every other remote read in the
  // repo strips these already (runHerdr); this test pins that this one does too.
  it("strips SSH chatter before parsing, so a healthy read is not reported as bad-schema", async () => {
    const exec: ExecFn = () => Promise.resolve({
      stdout: [
        "bind: Address already in use",
        "Warning: remote port forwarding failed for listen port 7070",
        JSON.stringify({ sessionId: "s1", status: "idle" }),
        "",
      ].join("\n"),
      stderr: "",
    });
    const out = await readRegistry(remoteEnv(["/home/u/.claude"]), exec);
    expect(out.status).toBe("ok");
    expect(out.records.map((r) => r.sessionId)).toEqual(["s1"]);
  });

  it("reports ok with zero records when the remote directory exists but is empty", async () => {
    const exec: ExecFn = () => Promise.resolve({ stdout: "", stderr: "" });
    const out = await readRegistry(remoteEnv(["/home/u/.claude"]), exec);
    expect(out.status).toBe("ok");
    expect(out.records).toEqual([]);
  });

  it("maps the remote exit code 3 to not-found, not to a read error", async () => {
    const exec: ExecFn = () => Promise.reject(new Error("Command failed", { cause: { code: 3 } }));
    expect((await readRegistry(remoteEnv(["/home/u/.claude"]), exec)).status).toBe("not-found");
  });

  // A timed-out or failed read must NEVER look like zero sessions: the row says "state unavailable",
  // never "idle", and the RC badge says "unknown" rather than "off".
  it("maps any other remote failure to read-error", async () => {
    const exec: ExecFn = () => Promise.reject(new Error("timed out", { cause: { code: 255 } }));
    const out = await readRegistry(remoteEnv(["/home/u/.claude"]), exec);
    expect(out.status).toBe("read-error");
    expect(out.records).toEqual([]);
  });

  it("maps a spawn failure with no numeric exit code to read-error", async () => {
    const exec: ExecFn = () => Promise.reject(new Error("spawn ssh ENOENT"));
    expect((await readRegistry(remoteEnv(["/home/u/.claude"]), exec)).status).toBe("read-error");
  });

  it("never execs for a remote config dir that fails the path guard", async () => {
    let called = false;
    const exec: ExecFn = () => { called = true; return Promise.resolve({ stdout: "", stderr: "" }); };
    const out = await readRegistry(remoteEnv(["/home/u/.claude; rm -rf /"]), exec);
    expect(called).toBe(false);
    expect(out.status).toBe("read-error");
  });

  // The remote stream is capped in RECEIVED bytes, which cuts the NDJSON mid-record. Dropping that
  // partial tail is what keeps `bad-schema` meaningful: without it a merely large remote registry
  // would fire the "Claude changed this file format" alarm on nothing at all.
  it("drops the partial tail record when the remote byte cap cuts the stream", async () => {
    const line = JSON.stringify({ sessionId: "0199c0de-1e5e-72f9-9b1d-1cb3d6f0abcd", status: "idle" });
    const count = Math.ceil(CLAUDE_REGISTRY_MAX_BYTES / (line.length + 1)) + 10;
    const exec: ExecFn = () => Promise.resolve({
      stdout: `${Array.from({ length: count }, () => line).join("\n")}\n`,
      stderr: "",
    });
    const out = await readRegistry(remoteEnv(["/home/u/.claude"]), exec);
    expect(out.truncated).toBe(true);
    expect(out.status).toBe("ok");
    expect(out.records.length).toBeGreaterThan(0);
  });
});
