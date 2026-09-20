import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { loadEnvironments } from "../environments.ts";

const dir = mkdtempSync(path.join(os.tmpdir(), "corral-env-cfg-"));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function write(name: string, cfg: unknown): string {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify(cfg), "utf8");
  return p;
}

function remote(id: string, mcpSocket?: string) {
  return {
    id, label: id, kind: "remote", sshHost: `host-${id}`, socket: `/s-${id}.sock`, herdrBin: "/herdr",
    ...(mcpSocket === undefined ? {} : { mcpSocket }),
  };
}

describe("mcpSocket", () => {
  it("is optional — an environment without one simply gets no remote MCP", () => {
    const envs = loadEnvironments(write("none.json", { environments: [remote("a")] }));
    const only = envs[0];
    expect(only?.kind).toBe("remote");
    if (only?.kind === "remote") expect(only.mcpSocket).toBeUndefined();
  });

  it("is carried through when present", () => {
    const envs = loadEnvironments(write("one.json", { environments: [remote("a", "/home/u/.corral/mcp.sock")] }));
    const only = envs[0];
    if (only?.kind === "remote") expect(only.mcpSocket).toBe("/home/u/.corral/mcp.sock");
  });

  it("refuses a relative path — sshd does not expand ~ or resolve a relative listen path", () => {
    expect(() => loadEnvironments(write("rel.json", { environments: [remote("a", "~/.corral/mcp.sock")] })))
      .toThrow(/absolute/);
  });

  it("refuses a colon — it would split the ssh forward spec", () => {
    expect(() => loadEnvironments(write("colon.json", { environments: [remote("a", "/home/u/a:b.sock")] })))
      .toThrow(/':'/);
  });

  it("refuses a path past the OS socket-path limit", () => {
    const tooLong = `/home/u/${"d".repeat(120)}.sock`;
    expect(() => loadEnvironments(write("long.json", { environments: [remote("a", tooLong)] })))
      .toThrow(/characters/);
  });

  it("refuses two environments sharing one path — it would pin their sessions to the wrong cards", () => {
    const cfg = { environments: [remote("a", "/home/u/.corral/mcp.sock"), remote("b", "/home/u/.corral/mcp.sock")] };
    expect(() => loadEnvironments(write("dup.json", cfg))).toThrow(/share one mcpSocket/);
  });
});
