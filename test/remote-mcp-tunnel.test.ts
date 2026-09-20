import { describe, expect, it } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import type { TunnelIo } from "../server/remote-mcp/tunnel.ts";
import { cancelTunnel, ensureTunnel, PROBE_SCRIPT } from "../server/remote-mcp/tunnel.ts";

type RemoteEnv = Extract<HerdrEnv, { kind: "remote" }>;

function remoteEnv(mcpSocket?: string): RemoteEnv {
  const base: RemoteEnv = {
    id: "e1", label: "E1", kind: "remote", sshHost: "host1", socket: "/s.sock", herdrBin: "/herdr",
    claudeConfigDirs: [], spawnCommand: "claude", repos: {},
  };
  return mcpSocket === undefined ? base : { ...base, mcpSocket };
}

interface FakeIo extends TunnelIo {
  readonly calls: string[];
}

function fakeIo(opts: { present: boolean; forwardFails?: boolean }): FakeIo {
  const calls: string[] = [];
  return {
    calls,
    answersOnRemoteSocket: async () => { calls.push("probe"); return Promise.resolve(opts.present); },
    clearRemoteSocket: async () => { calls.push("clear"); return Promise.resolve(); },
    forward: async () => {
      calls.push("forward");
      if (opts.forwardFails === true) throw new Error("no control socket");
      return Promise.resolve();
    },
    cancel: async () => { calls.push("cancel"); return Promise.resolve(); },
  };
}

describe("ensureTunnel", () => {
  it("leaves a live forward alone — it never unlinks a socket that is answering", async () => {
    const io = fakeIo({ present: true });
    expect(await ensureTunnel(remoteEnv("/home/u/.corral/mcp.sock"), "/local.sock", io)).toBe("already-present");
    expect(io.calls).toEqual(["probe"]);
  });

  it("clears the stale socket file before forwarding when nothing answers", async () => {
    const io = fakeIo({ present: false });
    expect(await ensureTunnel(remoteEnv("/home/u/.corral/mcp.sock"), "/local.sock", io)).toBe("forwarded");
    expect(io.calls).toEqual(["probe", "clear", "forward"]);
  });

  it("reports unreachable rather than throwing when the forward is refused", async () => {
    const io = fakeIo({ present: false, forwardFails: true });
    expect(await ensureTunnel(remoteEnv("/home/u/.corral/mcp.sock"), "/local.sock", io)).toBe("unreachable");
  });

  it("does nothing at all for an environment that configured no mcpSocket", async () => {
    const io = fakeIo({ present: false });
    expect(await ensureTunnel(remoteEnv(), "/local.sock", io)).toBe("unreachable");
    expect(io.calls).toEqual([]);
  });
});

describe("cancelTunnel", () => {
  it("drops the forward", async () => {
    const io = fakeIo({ present: true });
    await cancelTunnel(remoteEnv("/home/u/.corral/mcp.sock"), "/local.sock", io);
    expect(io.calls).toEqual(["cancel"]);
  });

  it("swallows a failure — the master may already be gone with the process", async () => {
    const io: TunnelIo = {
      answersOnRemoteSocket: () => Promise.resolve(false),
      clearRemoteSocket: () => Promise.resolve(),
      forward: () => Promise.resolve(),
      cancel: () => Promise.reject(new Error("control socket gone")),
    };
    await expect(cancelTunnel(remoteEnv("/home/u/.corral/mcp.sock"), "/local.sock", io)).resolves.toBeUndefined();
  });
});

describe("the remote probe script", () => {
  // The exact script corral sends, against a real socket — a fake cannot assert this distinction.
  const run = async (target: string): Promise<number> => {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) => {
      execFile("sh", ["-c", PROBE_SCRIPT, "sh", target], (err) => {
        resolve(err === null ? 0 : 1);
      });
    });
  };

  it("succeeds on a socket that answers, and fails on a leftover file or an absent path", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const net = await import("node:net");

    const dir = mkdtempSync(path.join(os.tmpdir(), "corral-probe-"));
    const live = path.join(dir, "live.sock");
    const stale = path.join(dir, "stale.sock");
    const absent = path.join(dir, "absent.sock");

    const srv = net.createServer(() => undefined);
    await new Promise<void>((r) => srv.listen(live, () => { r(); }));
    writeFileSync(stale, "");

    try {
      expect(await run(live)).toBe(0);
      expect(await run(stale)).toBe(1);
      expect(await run(absent)).toBe(1);
    } finally {
      await new Promise<void>((r) => srv.close(() => { r(); }));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
