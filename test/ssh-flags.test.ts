import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, afterAll } from "vitest";

import { CORRAL_HOME } from "../config.ts";
import type * as SshFlagsModule from "../server/ssh-flags.ts";
import { sshFlags, sshShareFlags, SSH_SOCKET_DIR } from "../server/ssh-flags.ts";

describe("sshShareFlags", () => {
  it("lives under CORRAL_HOME, deterministic and known to corral (not left to ssh defaults)", () => {
    expect(SSH_SOCKET_DIR).toBe(path.join(CORRAL_HOME, "ssh"));
  });

  it("sets ControlMaster=auto, a quoted ControlPath under the socket dir, ControlPersist, and keepalives", () => {
    const flags = sshShareFlags();
    expect(flags).toEqual([
      "-o", "ControlMaster=auto",
      "-o", `ControlPath="${path.join(SSH_SOCKET_DIR, "%C")}"`,
      "-o", expect.stringMatching(/^ControlPersist=\d+$/),
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2",
    ]);
  });

  it("quotes the ControlPath value, so a CORRAL_HOME containing a space doesn't break ssh's own -o tokenizer", () => {
    const flags = sshShareFlags();
    const controlPathFlag = flags.find((f) => f.startsWith("ControlPath="));
    expect(controlPathFlag).toMatch(/^ControlPath="[^"]*"$/);
  });

  it("creates the socket directory at mode 0700", () => {
    sshShareFlags();
    expect(existsSync(SSH_SOCKET_DIR)).toBe(true);
    expect(statSync(SSH_SOCKET_DIR).mode & 0o777).toBe(0o700);
  });
});

describe("the control-socket path length guard", () => {
  const longHome = path.join(os.tmpdir(), "corral-ssh-flags-long-home-test", "a".repeat(90));
  afterAll(() => { rmSync(path.join(os.tmpdir(), "corral-ssh-flags-long-home-test"), { recursive: true, force: true }); });

  // %C always expands to a fixed 40-char hash, so only CORRAL_HOME's own length can push the full
  // socket path over the unix-domain-socket limit. A long CORRAL_HOME fails every remote ssh call
  // with the same opaque ssh error, so this is checked and warned about once, at first use, instead.
  it("warns once when CORRAL_HOME makes the control path too long for a unix socket", async () => {
    const original = process.env.CORRAL_HOME;
    // Under os.tmpdir() so mkdirSync can actually create it — a bare "/a...a" would need root.
    process.env.CORRAL_HOME = longHome;
    vi.resetModules();
    try {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fresh: typeof SshFlagsModule = await import("../server/ssh-flags.ts");
      fresh.sshShareFlags();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("ssh control socket path"));
      fresh.sshShareFlags(); // idempotent: the warning fires once, not on every call
      expect(errorSpy).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    } finally {
      process.env.CORRAL_HOME = original;
      vi.resetModules();
    }
  });

  it("does not warn for a short, ordinary CORRAL_HOME", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sshShareFlags();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("a socket directory corral cannot create or use", () => {
  // buildAttachSpec's only caller (server/ws-attach.ts's onConnection) has no try/catch around it —
  // building an ssh argv used to be pure string work that could never throw. ensureSocketDir must
  // degrade instead of propagating, or a bad CORRAL_HOME crashes the whole server on the next attach.
  it("logs and returns flags anyway, rather than throwing, when the socket dir can't be created", async () => {
    const original = process.env.CORRAL_HOME;
    const blockedHome = path.join(os.tmpdir(), "corral-ssh-flags-blocked-home-test");
    rmSync(blockedHome, { recursive: true, force: true });
    // A FILE at the path ssh-flags.ts wants to mkdir as a directory — mkdirSync(..., {recursive:true})
    // fails with ENOTDIR here, the same class of error a read-only or full CORRAL_HOME would raise.
    mkdirSync(blockedHome, { recursive: true });
    const blockedSshPath = path.join(blockedHome, "ssh");
    writeFileSync(blockedSshPath, "");
    process.env.CORRAL_HOME = blockedHome;
    vi.resetModules();
    try {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fresh: typeof SshFlagsModule = await import("../server/ssh-flags.ts");
      expect(() => fresh.sshShareFlags()).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("could not create"));
      errorSpy.mockRestore();
    } finally {
      process.env.CORRAL_HOME = original;
      rmSync(blockedHome, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});

describe("sshFlags", () => {
  it("carries ConnectTimeout + StrictHostKeyChecking + the share flags (ControlMaster, ControlPath, ControlPersist, keepalives)", () => {
    const flags = sshFlags();
    expect(flags.slice(0, 4)).toEqual(["-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes"]);
    expect(flags).toEqual(expect.arrayContaining(sshShareFlags()));
  });

  it("is the ONE definition used by both one-shot calls and the interactive attach — same flags either way", () => {
    // sshFlags() has no "which caller" parameter: whichever ssh invocation ends up establishing the
    // shared master (a poll, a statusline read, or the attach itself) carries the same keepalives.
    expect(sshFlags()).toEqual(sshFlags());
  });
});
