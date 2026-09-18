import { EventEmitter } from "node:events";
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
