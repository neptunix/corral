import type { Check } from "@shared/diagnostics-schema";
import { describe, expect, it } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import type { CheckDeps } from "../server/diagnostics/deps.ts";
import { mcpChecks, mcpTunnelCheck, registrationFiles } from "../server/diagnostics/mcp.ts";
import { createTunnelStatus } from "../server/remote-mcp/status.ts";

type RemoteEnv = Extract<HerdrEnv, { kind: "remote" }>;

const DIR = "/h/.claude";
const SOCK = "/h/.corral/mcp.sock";
const SHIM = "/h/.corral/mcp-shim.mjs";

const localEnv: HerdrEnv = { id: "here", label: "here", kind: "local", claudeConfigDirs: [DIR], spawnCommand: "claude", repos: {} };
const remoteEnv = (mcpSocket?: string): RemoteEnv => {
  const base: RemoteEnv = {
    id: "far", label: "far", kind: "remote", sshHost: "h", socket: "/s", herdrBin: "herdr",
    claudeConfigDirs: [DIR], spawnCommand: "claude", repos: {},
  };
  return mcpSocket === undefined ? base : { ...base, mcpSocket };
};

const registration = (env: Record<string, string> = { CORRAL_MCP_SOCKET: SOCK }): string =>
  JSON.stringify({ mcpServers: { corral: { type: "stdio", command: "node", args: [SHIM], env } } });

function deps(files: Record<string, string>, hashes: Record<string, string> = {}): CheckDeps {
  return {
    env: { HOME: "/h" }, pathEnv: "", nodeVersion: "22.0.0",
    isFile: (p) => p in files, isExec: () => false, isDir: () => false,
    readText: (p) => files[p] ?? null,
    hashFile: (p) => hashes[p] ?? (p in files ? "same" : null),
    repoRoot: "/repo", now: () => 1,
  };
}

const byId = (rows: readonly Check[], id: string): Check | undefined => rows.find((r) => r.id === id);

describe("registrationFiles", () => {
  it("adds the home-level file only for the default dir name", () => {
    expect(registrationFiles("/h/.claude")).toEqual(["/h/.claude/.claude.json", "/h/.claude.json"]);
    expect(registrationFiles("/h/.claude-work")).toEqual(["/h/.claude-work/.claude.json"]);
  });
});

describe("mcpChecks", () => {
  it("emits nothing for a remote env with no mcpSocket — opted out is never a fault", () => {
    expect(mcpChecks(deps({}), remoteEnv(), DIR)).toEqual([]);
  });

  it("is healthy when registered at the served socket with the shim in place", () => {
    const rows = mcpChecks(deps({ "/h/.claude.json": registration(), [SHIM]: "x" }), remoteEnv(SOCK), DIR);
    expect(rows.map((r) => [r.id, r.state])).toEqual([["mcp-registered", "ok"], ["mcp-shim-installed", "ok"]]);
  });

  it("flags a remote dir with no registration, and cannot judge the shim then", () => {
    const rows = mcpChecks(deps({}), remoteEnv(SOCK), DIR);
    expect(byId(rows, "mcp-registered")).toMatchObject({ state: "problem", severity: "warning" });
    expect(byId(rows, "mcp-shim-installed")?.state).toBe("n/a");
  });

  it("flags a registered shim file that is not there", () => {
    const rows = mcpChecks(deps({ [`${DIR}/.claude.json`]: registration() }), remoteEnv(SOCK), DIR);
    expect(byId(rows, "mcp-shim-installed")).toMatchObject({ state: "problem" });
    expect(byId(rows, "mcp-shim-installed")?.detail).toContain(SHIM);
  });

  it("flags a shim that differs from the checkout", () => {
    const d = deps({ "/h/.claude.json": registration(), [SHIM]: "x" }, { [SHIM]: "old", "/repo/scripts/corral-mcp-shim.mjs": "new" });
    expect(byId(mcpChecks(d, remoteEnv(SOCK), DIR), "mcp-shim-installed")?.state).toBe("problem");
  });

  it("flags a registration whose socket is not the one corral serves", () => {
    const d = deps({ "/h/.claude.json": registration({ CORRAL_MCP_SOCKET: "/other.sock" }), [SHIM]: "x" });
    const row = byId(mcpChecks(d, remoteEnv(SOCK), DIR), "mcp-registered");
    expect(row?.state).toBe("problem");
    expect(row?.detail).toContain("/other.sock");
  });

  it("reads n/a, not a fault, when the registration file is over the size cap", () => {
    const d: CheckDeps = { ...deps({ "/h/.claude.json": "" }), readText: () => null };
    expect(byId(mcpChecks(d, remoteEnv(SOCK), DIR), "mcp-registered")?.state).toBe("n/a");
  });

  it("reads n/a when the registration file is not JSON", () => {
    expect(byId(mcpChecks(deps({ "/h/.claude.json": "{nope" }), remoteEnv(SOCK), DIR), "mcp-registered")?.state).toBe("n/a");
  });

  it("checks local registration only, and only as a recommendation", () => {
    const missing = mcpChecks(deps({}), localEnv, DIR);
    expect(missing.map((r) => r.id)).toEqual(["mcp-registered"]);
    expect(missing[0]).toMatchObject({ state: "problem", severity: "info" });
    expect(mcpChecks(deps({ [`${DIR}/.claude.json`]: registration({}) }), localEnv, DIR)[0]?.state).toBe("ok");
  });

  it("ignores servers registered under another name", () => {
    const other = JSON.stringify({ mcpServers: { unrelated: { command: "x" } } });
    expect(mcpChecks(deps({ "/h/.claude.json": other }), localEnv, DIR)[0]?.state).toBe("problem");
  });
});

describe("mcpTunnelCheck", () => {
  const at = { at: 5 };
  it("is n/a — not a problem — for an env that opted out", () => {
    const row = mcpTunnelCheck(remoteEnv(), createTunnelStatus(), 9);
    expect(row.state).toBe("n/a");
    expect(row.title).toContain("not configured");
  });

  it("is pending before the first tick, ok when up, and problem with the port-forwarding hint when down", () => {
    const status = createTunnelStatus();
    const env = remoteEnv(SOCK);
    expect(mcpTunnelCheck(env, status, 9).state).toBe("pending");
    status.record("far", { up: true, ...at });
    expect(mcpTunnelCheck(env, status, 9).state).toBe("ok");
    status.record("far", { up: false, ...at });
    const down = mcpTunnelCheck(env, status, 9);
    expect(down).toMatchObject({ state: "problem", severity: "warning" });
    expect(down.detail).toContain("port-forwarding");
  });
});
