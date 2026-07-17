import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { loadEnvironments, getEnv } from "../environments.ts";

const dir = mkdtempSync(path.join(os.tmpdir(), "corral-env-"));
function fixture(name: string, data: unknown): string {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify(data));
  return p;
}

describe("environments config loader", () => {
  it("loads and Zod-validates a config file (order preserved)", () => {
    const p = fixture("ok.json", {
      environments: [
        { id: "work-local", label: "Work (local)", kind: "local" },
        { id: "personal-remote", label: "Personal", kind: "remote", sshHost: "personal-box", socket: "~/x.sock", herdrBin: "~/.local/bin/herdr" },
      ],
    });
    const envs = loadEnvironments(p);
    expect(envs.map((e) => e.id)).toEqual(["work-local", "personal-remote"]);
    const remote = envs[1];
    expect(remote?.kind).toBe("remote");
    if (remote?.kind === "remote") expect(remote.sshHost).toBe("personal-box");
  });

  it("rejects a remote env missing sshHost", () => {
    const p = fixture("bad.json", { environments: [{ id: "x", label: "X", kind: "remote", socket: "~/x.sock", herdrBin: "~/h" }] });
    expect(() => loadEnvironments(p)).toThrow();
  });

  it("rejects an env id containing a colon or other unsafe chars (breaks the env:paneId key split)", () => {
    // Attention keys are `${env.id}:${paneId}` split on the FIRST colon by both the server enrichment
    // and the client's terminal-open routing — a colon inside the id lands the split inside the id.
    for (const id of ["prod:eu", "has space", "a/b"]) {
      const p = fixture(`bad-id-${id.replace(/[^a-z]/g, "_")}.json`, {
        environments: [{ id, label: "X", kind: "local" }],
      });
      expect(() => loadEnvironments(p), `id ${JSON.stringify(id)} should be rejected`).toThrow(/env id/);
    }
  });

  it("throws a helpful error when the file is missing", () => {
    expect(() => loadEnvironments(path.join(dir, "nope.json"))).toThrow(/environments config/);
  });

  it("getEnv resolves from the fixture and throws on unknown id", () => {
    expect(getEnv("work-local").id).toBe("work-local");
    expect(() => getEnv("nope")).toThrow("unknown environment: nope");
  });
});

describe("claudeConfigDirs", () => {
  it("local env with no claudeConfigDirs defaults to ~/.claude (~ expanded)", () => {
    const p = fixture("local-no-dirs.json", {
      environments: [{ id: "l", label: "L", kind: "local" }],
    });
    expect(loadEnvironments(p)[0]?.claudeConfigDirs).toEqual([
      path.join(os.homedir(), ".claude"),
    ]);
  });

  it("local env with explicit claudeConfigDirs expands ~ and keeps absolute paths", () => {
    const p = fixture("local-custom-dirs.json", {
      environments: [{ id: "x", label: "X", kind: "local", claudeConfigDirs: ["~/.claude-custom", "/abs/path"] }],
    });
    const envs = loadEnvironments(p);
    expect(envs[0]?.claudeConfigDirs).toEqual([
      path.join(os.homedir(), ".claude-custom"),
      "/abs/path",
    ]);
  });

  it("remote env rejects ~ in claudeConfigDirs", () => {
    const p = fixture("bad-remote-dirs.json", {
      environments: [{
        id: "x", label: "X", kind: "remote",
        sshHost: "host", socket: "~/s.sock", herdrBin: "~/h",
        claudeConfigDirs: ["~/.claude"],
      }],
    });
    expect(() => loadEnvironments(p)).toThrow(/absolute/);
  });

  it("remote env with absolute claudeConfigDirs accepted", () => {
    const p = fixture("ok-remote-dirs.json", {
      environments: [{
        id: "x", label: "X", kind: "remote",
        sshHost: "host", socket: "~/s.sock", herdrBin: "~/h",
        claudeConfigDirs: ["/home/user/.claude"],
      }],
    });
    const envs = loadEnvironments(p);
    expect(envs[0]?.claudeConfigDirs).toEqual(["/home/user/.claude"]);
  });

  it("remote env with no claudeConfigDirs defaults to empty array", () => {
    const p = fixture("remote-no-dirs.json", {
      environments: [{ id: "x", label: "X", kind: "remote", sshHost: "host", socket: "~/s.sock", herdrBin: "~/h" }],
    });
    const envs = loadEnvironments(p);
    expect(envs[0]?.claudeConfigDirs).toEqual([]);
  });
});

describe("spawnCommand", () => {
  it("defaults to 'claude' when unset", () => {
    const p = fixture("no-cmd.json", { environments: [{ id: "x", label: "X", kind: "local" }] });
    expect(loadEnvironments(p)[0]?.spawnCommand).toBe("claude");
  });

  it("keeps an explicit spawnCommand (e.g. claude-personal on personal-* envs)", () => {
    const p = fixture("personal-cmd.json", {
      environments: [{ id: "personal-local", label: "Personal", kind: "local", spawnCommand: "claude-personal" }],
    });
    expect(loadEnvironments(p)[0]?.spawnCommand).toBe("claude-personal");
  });
});

describe("repos map", () => {
  it("local repos: ~ is expanded, absolute kept, missing → {}", () => {
    const p = fixture("local-repos.json", {
      environments: [{
        id: "work-local", label: "W", kind: "local",
        repos: { corral: "~/code/corral", abs: "/srv/abs" },
      }],
    });
    const env = loadEnvironments(p)[0];
    expect(env?.repos).toEqual({
      corral: path.join(os.homedir(), "code/corral"),
      abs: "/srv/abs",
    });
    const p2 = fixture("no-repos.json", { environments: [{ id: "x", label: "X", kind: "local" }] });
    expect(loadEnvironments(p2)[0]?.repos).toEqual({});
  });

  it("remote repos rejects ~ (not expanded on the remote shell)", () => {
    const p = fixture("bad-remote-repos.json", {
      environments: [{
        id: "personal-remote", label: "Personal", kind: "remote", sshHost: "h", socket: "~/s.sock", herdrBin: "~/h",
        repos: { "demo-repo": "~/code/demo-repo" },
      }],
    });
    expect(() => loadEnvironments(p)).toThrow(/absolute/);
  });

  it("remote repos with absolute paths accepted", () => {
    const p = fixture("ok-remote-repos.json", {
      environments: [{
        id: "personal-remote", label: "Personal", kind: "remote", sshHost: "h", socket: "~/s.sock", herdrBin: "~/h",
        repos: { "demo-repo": "/home/me/code/demo-repo" },
      }],
    });
    expect(loadEnvironments(p)[0]?.repos).toEqual({ "demo-repo": "/home/me/code/demo-repo" });
  });

  it("environments.example.json is valid and loads", () => {
    expect(() => loadEnvironments("environments.example.json")).not.toThrow();
  });
});
