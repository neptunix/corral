import { afterEach, describe, expect, it, vi } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { startRemoteMcp } from "../server/remote-mcp/index.ts";
import { startEnvListener } from "../server/remote-mcp/listener.ts";
import { createTunnelStatus } from "../server/remote-mcp/status.ts";
import { cancelTunnel, ensureTunnel } from "../server/remote-mcp/tunnel.ts";

vi.mock("../server/remote-mcp/listener.ts", () => ({ startEnvListener: vi.fn() }));
vi.mock("../server/remote-mcp/tunnel.ts", () => ({ ensureTunnel: vi.fn(), cancelTunnel: vi.fn() }));

const env = (id: string, mcpSocket?: string): HerdrEnv => {
  const base: HerdrEnv = {
    id, label: id, kind: "remote", sshHost: "h", socket: "/s", herdrBin: "herdr",
    claudeConfigDirs: [], spawnCommand: "claude", repos: {},
  };
  return mcpSocket === undefined ? base : { ...base, mcpSocket };
};

const start = async (envs: HerdrEnv[]) => {
  const status = createTunnelStatus();
  const stop = await startRemoteMcp({
    envs, poller: { getSnapshot: () => ({ envs: {}, sessions: [] }), refreshEnv: () => Promise.resolve() }, storage: undefined,
    paneLookup: () => Promise.resolve(null), baseUrl: "http://127.0.0.1:1", intervalMs: 3_600_000, status,
  });
  await stop();
  return status;
};

afterEach(() => { vi.resetAllMocks(); });

describe("startRemoteMcp tunnel status", () => {
  const listener = { socketPath: "/local.sock", close: () => Promise.resolve() };

  it.each([["forwarded", "up"], ["already-present", "up"], ["unreachable", "down"]] as const)(
    "records %s as %s", async (state, reading) => {
      vi.mocked(startEnvListener).mockResolvedValue(listener);
      vi.mocked(ensureTunnel).mockResolvedValue(state);
      vi.mocked(cancelTunnel).mockResolvedValue();
      expect((await start([env("on", "/far/mcp.sock")])).get("on")).toBe(reading);
    },
  );

  it("records no-listener when the local listener cannot start, and nothing for an opted-out env", async () => {
    vi.mocked(startEnvListener).mockRejectedValue(new Error("EADDRINUSE"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const status = await start([env("on", "/far/mcp.sock"), env("off")]);
    expect(status.get("on")).toBe("no-listener");
    expect(status.get("off")).toBeUndefined();
  });
});
