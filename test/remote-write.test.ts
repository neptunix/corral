import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import type { RemoteChild, SpawnSsh } from "../server/remote-write.ts";
import { remoteWriteTimeoutMs, writeRemoteFile } from "../server/remote-write.ts";

const env: Extract<HerdrEnv, { kind: "remote" }> = {
  id: "e", label: "E", kind: "remote", sshHost: "host1", socket: "~/s.sock", herdrBin: "~/herdr",
  claudeConfigDirs: [], spawnCommand: "claude", repos: {},
};

interface Fake {
  readonly spawnFn: SpawnSsh;
  readonly calls: { file: string; args: readonly string[] }[];
  readonly written: Uint8Array[];
  readonly killed: () => boolean;
  readonly out: EventEmitter;
  readonly err: EventEmitter;
  readonly child: EventEmitter;
}

function fake(): Fake {
  const out = new EventEmitter();
  const err = new EventEmitter();
  const calls: Fake["calls"] = [];
  const written: Uint8Array[] = [];
  let killed = false;
  class FakeChild extends EventEmitter implements RemoteChild {
    stdin = { end: (d: Uint8Array) => { written.push(d); }, on: () => undefined };
    stdout = out;
    stderr = err;
    kill(): void { killed = true; }
  }
  const rc = new FakeChild();
  return { spawnFn: (file, args) => { calls.push({ file, args }); return rc; }, calls, written, killed: () => killed, out, err, child: rc };
}

describe("writeRemoteFile", () => {
  it("pipes the bytes to ssh on the shared connection and returns the printed path", async () => {
    const f = fake();
    const p = writeRemoteFile(env, { name: "shot.png", bytes: new Uint8Array([1, 2, 3]), spawnFn: f.spawnFn });
    f.out.emit("data", Buffer.from("/remote/tmp/corral-upload.abc/shot.png"));
    f.child.emit("close", 0);
    expect(await p).toBe("/remote/tmp/corral-upload.abc/shot.png");
    expect([...(f.written[0] ?? [])]).toEqual([1, 2, 3]);
    const call = f.calls[0];
    expect(call?.file).toBe("ssh");
    const args = call?.args ?? [];
    expect(args).toContain("ControlMaster=auto");
    expect(args.some((a) => a.startsWith("ControlPath="))).toBe(true);
    const hostAt = args.indexOf("host1");
    expect(hostAt).toBe(args.length - 2);
    // the name travels as its own argument to sh, not inside the script
    expect(args[hostAt + 1]).toMatch(/^sh -c .* sh shot\.png$/);
  });

  it("quotes a hostile name instead of splicing it into the command", async () => {
    const f = fake();
    const p = writeRemoteFile(env, { name: "a b;rm -rf x", bytes: new Uint8Array(), spawnFn: f.spawnFn });
    f.child.emit("close", 1);
    await expect(p).rejects.toThrow();
    expect(f.calls[0]?.args.at(-1)).toMatch(/ sh 'a b;rm -rf x'$|sh a\\ b\\;rm\\ -rf\\ x$/);
  });

  it("rejects with the ssh error line on a non-zero exit, ignoring ssh noise", async () => {
    const f = fake();
    const p = writeRemoteFile(env, { name: "f", bytes: new Uint8Array(), spawnFn: f.spawnFn });
    f.err.emit("data", Buffer.from("Warning: remote port forwarding failed\nmktemp: cannot create: Permission denied\n"));
    f.child.emit("close", 1);
    await expect(p).rejects.toThrow("Permission denied");
  });

  it("accepts a remote path containing a space", async () => {
    const f = fake();
    const p = writeRemoteFile(env, { name: "f", bytes: new Uint8Array(), spawnFn: f.spawnFn });
    f.out.emit("data", Buffer.from("/remote/my tmp/corral-upload.abc/f"));
    f.child.emit("close", 0);
    expect(await p).toBe("/remote/my tmp/corral-upload.abc/f");
  });

  it("rejects when ssh prints something that is not an absolute path", async () => {
    const f = fake();
    const p = writeRemoteFile(env, { name: "f", bytes: new Uint8Array(), spawnFn: f.spawnFn });
    f.out.emit("data", Buffer.from("welcome banner"));
    f.child.emit("close", 0);
    await expect(p).rejects.toThrow("no usable path");
  });

  it("kills ssh and rejects when the overall timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      const f = fake();
      const p = writeRemoteFile(env, { name: "f", bytes: new Uint8Array(), timeoutMs: 1000, spawnFn: f.spawnFn });
      const assertion = expect(p).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(f.killed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when ssh cannot start", async () => {
    const f = fake();
    const p = writeRemoteFile(env, { name: "f", bytes: new Uint8Array(), spawnFn: f.spawnFn });
    f.child.emit("error", new Error("spawn ssh ENOENT"));
    await expect(p).rejects.toThrow("ENOENT");
  });

  it("scales the timeout with payload size", () => {
    expect(remoteWriteTimeoutMs(25 * 1024 * 1024)).toBeGreaterThan(remoteWriteTimeoutMs(1024));
  });
});

// Runs the REAL remote command under a local `sh` (the last ssh argument is exactly what the remote
// login shell would receive), so the script itself is exercised, not just its argv.
describe("writeRemoteFile remote script (run under a local sh)", () => {
  function runLocally(tmp: string): SpawnSsh {
    return (_file, args) => spawn("sh", ["-c", args.at(-1) ?? ""], { env: { ...process.env, TMPDIR: tmp } });
  }
  function scratch(): { dir: string; done: () => void } {
    const dir = mkdtempSync(path.join(os.tmpdir(), "remote-write-"));
    return { dir, done: () => { rmSync(dir, { recursive: true, force: true }); } };
  }

  it("writes the bytes into a private 0700 directory with a 0600 file", async () => {
    const s = scratch();
    try {
      const p = await writeRemoteFile(env, { name: "shot.png", bytes: new Uint8Array([9, 8, 7]), spawnFn: runLocally(s.dir) });
      expect(p.startsWith(s.dir + path.sep + "corral-upload.")).toBe(true);
      expect([...readFileSync(p)]).toEqual([9, 8, 7]);
      expect(statSync(path.dirname(p)).mode & 0o777).toBe(0o700);
      expect(statSync(p).mode & 0o777).toBe(0o600);
    } finally { s.done(); }
  });

  it("keeps hostile names literal and executes nothing", async () => {
    const s = scratch();
    try {
      for (const name of ["a b;touch pwned", "$(touch pwned2)", "it's", "-x", "`touch pwned3`"]) {
        const p = await writeRemoteFile(env, { name, bytes: new Uint8Array([1]), spawnFn: runLocally(s.dir) });
        expect(path.basename(p)).toBe(name);
        expect(existsSync(p)).toBe(true);
      }
      expect(readdirSync(s.dir).filter((e) => !e.startsWith("corral-upload."))).toEqual([]);
    } finally { s.done(); }
  });

  it("handles an empty payload", async () => {
    const s = scratch();
    try {
      const p = await writeRemoteFile(env, { name: "empty", bytes: new Uint8Array(), spawnFn: runLocally(s.dir) });
      expect(statSync(p).size).toBe(0);
    } finally { s.done(); }
  });

  it("fails and leaves nothing behind when the file cannot be created", async () => {
    const s = scratch();
    try {
      // A name longer than the filesystem allows makes `cat >` fail after mktemp succeeded.
      await expect(writeRemoteFile(env, { name: "x".repeat(300), bytes: new Uint8Array([1]), spawnFn: runLocally(s.dir) })).rejects.toThrow("remote write failed");
      expect(readdirSync(s.dir)).toEqual([]);
    } finally { s.done(); }
  });

  it("fails when the temp dir is unusable", async () => {
    await expect(writeRemoteFile(env, { name: "f", bytes: new Uint8Array(), spawnFn: runLocally("/nonexistent-corral-tmp") })).rejects.toThrow("remote write failed");
  });
});
