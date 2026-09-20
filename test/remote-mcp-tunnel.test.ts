import { describe, expect, it } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import type { TunnelIo } from "../server/remote-mcp/tunnel.ts";
import { cancelTunnel, ensureTunnel } from "../server/remote-mcp/tunnel.ts";

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
    probe: async () => { calls.push("probe"); return Promise.resolve(opts.present); },
    prepare: async () => { calls.push("prepare"); return Promise.resolve(); },
    forward: async () => {
      calls.push("forward");
      if (opts.forwardFails === true) throw new Error("no control socket");
      return Promise.resolve();
    },
    cancel: async () => { calls.push("cancel"); return Promise.resolve(); },
  };
}

describe("ensureTunnel", () => {
  it("leaves a live forward alone — it never unlinks a socket that is working", async () => {
    const io = fakeIo({ present: true });
    expect(await ensureTunnel(remoteEnv("/home/u/.corral/mcp.sock"), "/local.sock", io)).toBe("already-present");
    // The repair is destructive (rm -f before re-forwarding), so probing first is the whole point.
    expect(io.calls).toEqual(["probe"]);
  });

  it("clears the stale socket file before forwarding when none is present", async () => {
    const io = fakeIo({ present: false });
    expect(await ensureTunnel(remoteEnv("/home/u/.corral/mcp.sock"), "/local.sock", io)).toBe("forwarded");
    expect(io.calls).toEqual(["probe", "prepare", "forward"]);
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
      probe: () => Promise.resolve(false),
      prepare: () => Promise.resolve(),
      forward: () => Promise.resolve(),
      cancel: () => Promise.reject(new Error("control socket gone")),
    };
    await expect(cancelTunnel(remoteEnv("/home/u/.corral/mcp.sock"), "/local.sock", io)).resolves.toBeUndefined();
  });
});
