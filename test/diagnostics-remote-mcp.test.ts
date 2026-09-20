import type { Check } from "@shared/diagnostics-schema";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { composeRemoteRows, planRound2For } from "../server/diagnostics/remote/adapter.ts";
import { buildManifest } from "../server/diagnostics/remote/manifest.ts";
import type { ProbeFacts } from "../server/diagnostics/remote/probe.ts";
import type { RemoteEnv } from "../server/diagnostics/remote/script.ts";
import type { ProbeAnswer } from "../server/diagnostics/remote/wire.ts";

const DIR = "/far/.claude";
const SOCK = "/far/.corral/mcp.sock";
const SHIM = "/far/.corral/mcp-shim.mjs";
const SHIM_BYTES = "// shim";

const content = (s: string): ProbeAnswer => ({ kind: "content", bytes: Buffer.from(s), executable: false });
const env = (mcpSocket?: string): RemoteEnv => {
  const base: RemoteEnv = {
    id: "box", label: "box", kind: "remote", sshHost: "h", socket: "/s", herdrBin: "herdr",
    claudeConfigDirs: [DIR], spawnCommand: "claude", repos: {},
  };
  return mcpSocket === undefined ? base : { ...base, mcpSocket };
};
const registration = JSON.stringify({
  mcpServers: { corral: { command: "node", args: [SHIM], env: { CORRAL_MCP_SOCKET: SOCK } } },
});
// Like a real probe, every manifest path answers — absent unless the fixture says otherwise.
const probe = (byPath: Record<string, ProbeAnswer>): ProbeFacts => ({
  byPath: new Map(Object.entries({ [`${DIR}/.claude.json`]: { kind: "absent" }, "/far/.claude.json": { kind: "absent" }, ...byPath })), home: "/far", pathEnv: "", tools: new Map(),
  expected: 1, arrived: 1, error: null,
});
const localHash = (p: string): string | null =>
  p === "/repo/scripts/corral-mcp-shim.mjs" ? createHash("sha256").update(SHIM_BYTES).digest("hex") : null;

const rowsFor = async (e: RemoteEnv, facts: ProbeFacts): Promise<Check[]> =>
  [...await composeRemoteRows({
    env: e, probe: facts, reason: null, repoRoot: "/repo", nodeVersion: "22.0.0",
    now: () => 1, localHash, ccVersion: null,
  })].filter((c) => c.id.startsWith("mcp-"));

describe("buildManifest — registration files", () => {
  it("asks for them only when the env has mcpSocket, home-level sibling included", () => {
    const paths = (mcp: boolean): string[] => buildManifest([DIR], { mcp }).entries.map((e) => e.path);
    expect(paths(false)).not.toContain(`${DIR}/.claude.json`);
    expect(paths(true)).toEqual(expect.arrayContaining([`${DIR}/.claude.json`, "/far/.claude.json"]));
  });
});

describe("planRound2For — the shim path", () => {
  it("requests the file the registration launches, and nothing when opted out", () => {
    const facts = { byPath: probe({ "/far/.claude.json": content(registration) }).byPath, home: "/far", pathEnv: null };
    expect(planRound2For(env(SOCK))(facts).requests.map((r) => r.path)).toContain(SHIM);
    expect(planRound2For(env())(facts).requests.map((r) => r.path)).not.toContain(SHIM);
  });
});

describe("remote MCP rows", () => {
  it("are ok when registered at the served socket with a matching shim", async () => {
    const rows = await rowsFor(env(SOCK), probe({ "/far/.claude.json": content(registration), [SHIM]: content(SHIM_BYTES) }));
    expect(rows.map((c) => [c.id, c.state, c.class])).toEqual([
      ["mcp-registered", "ok", "remote"], ["mcp-shim-installed", "ok", "remote"],
    ]);
  });

  it("flag a shim the registration names but the host lacks", async () => {
    const rows = await rowsFor(env(SOCK), probe({ "/far/.claude.json": content(registration), [SHIM]: { kind: "absent" } }));
    expect(rows.find((c) => c.id === "mcp-shim-installed")?.state).toBe("problem");
  });

  it("do not exist for an env that opted out, whatever the host holds", async () => {
    const rows = await rowsFor(env(), probe({ "/far/.claude.json": content(registration) }));
    expect(rows).toEqual([]);
  });
});
