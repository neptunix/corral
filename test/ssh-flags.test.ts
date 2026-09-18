import { existsSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, afterAll } from "vitest";

import { CORRAL_HOME } from "../config.ts";
import type * as SshFlagsModule from "../server/ssh-flags.ts";
import { sshAttachFlags, sshOneShotFlags, sshShareFlags, SSH_SOCKET_DIR } from "../server/ssh-flags.ts";

describe("sshShareFlags", () => {
  it("lives under CORRAL_HOME, deterministic and known to corral (not left to ssh defaults)", () => {
    expect(SSH_SOCKET_DIR).toBe(path.join(CORRAL_HOME, "ssh"));
  });

  it("sets ControlMaster=auto, a ControlPath under the socket dir, and a ControlPersist window", () => {
    const flags = sshShareFlags();
    expect(flags).toEqual([
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${path.join(SSH_SOCKET_DIR, "%C")}`,
      "-o", expect.stringMatching(/^ControlPersist=\d+$/),
    ]);
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

describe("sshOneShotFlags", () => {
  it("carries ConnectTimeout + StrictHostKeyChecking + the share flags, in that order", () => {
    const flags = sshOneShotFlags();
    expect(flags.slice(0, 4)).toEqual(["-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes"]);
    expect(flags).toContain("ControlMaster=auto");
  });
});

describe("sshAttachFlags", () => {
  it("carries ConnectTimeout + keepalives + StrictHostKeyChecking + the same share flags as one-shot calls", () => {
    const flags = sshAttachFlags();
    expect(flags).toContain("ConnectTimeout=8");
    expect(flags).toContain("ServerAliveInterval=15");
    expect(flags).toContain("ServerAliveCountMax=2");
    expect(flags).toContain("StrictHostKeyChecking=yes");
    expect(flags).toContain("ControlMaster=auto");
    // Same ControlPath as sshOneShotFlags — the interactive attach shares the master a one-shot
    // call may already have open, and vice versa.
    expect(flags).toEqual(expect.arrayContaining(sshShareFlags()));
  });
});
