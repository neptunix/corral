
import type { Check } from "@shared/diagnostics-schema";
import { SessionRowSchema, type SessionRow } from "@shared/schema";
import { describe, it, expect } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import type { CheckDeps } from "../server/diagnostics/deps.ts";
import {
  compareSemver, configDirExistsChecks, envChecks, jqPresentCheck, nodeVersionCheck,
} from "../server/diagnostics/env.ts";

const NOW = 5_000;
const deps = (over: Partial<CheckDeps>): CheckDeps => ({
  env: { HOME: "/h" }, pathEnv: "/usr/bin", nodeVersion: "22.3.1",
  isFile: () => true, isExec: () => true, isDir: () => true,
  readText: () => null, hashFile: () => "h",
  repoRoot: "/repo", now: () => NOW,
  ...over,
});
const local = (id: string, dirs: readonly string[]): HerdrEnv => ({
  id, label: id, kind: "local", claudeConfigDirs: dirs, spawnCommand: "claude", repos: {},
});
const remote = (id: string): HerdrEnv => ({
  id, label: id, kind: "remote", sshHost: "h", socket: "~/s.sock", herdrBin: "herdr",
  claudeConfigDirs: ["/far/.claude"], spawnCommand: "claude", repos: {},
});
// Built through the schema so the OPTIONAL fields get their defaults. The seven required ones —
// env, paneId, status, agent, cwd, tab, workspace (shared/schema.ts:70-78) — have no defaults and
// must be supplied, or `.parse` throws before any assertion runs. There is no `title` field.
const row = (env: string, statuslineStatus: string | null): SessionRow =>
  SessionRowSchema.parse({
    env, paneId: "p1", status: "idle", agent: "claude", cwd: "/repo", tab: "t1", workspace: "w1",
    sessionId: "s1", statuslineStatus,
  });
const pick = (cs: readonly Check[], id: string, envId?: string): Check | undefined =>
  cs.find((c) => c.id === id && (envId === undefined || (c.scope.kind !== "global" && c.scope.envId === envId)));

describe("compareSemver", () => {
  it("compares numerically, not lexically — 0.6.10 is newer than 0.6.9", () => {
    expect(compareSemver("0.6.10", "0.6.9")).toBe(1);
  });
  it("handles equal, older, short, prefixed and prerelease forms", () => {
    expect(compareSemver("0.8.0", "0.8.0")).toBe(0);
    expect(compareSemver("0.7.0", "0.7.5")).toBe(-1);
    expect(compareSemver("1.0", "0.9.9")).toBe(1);
    expect(compareSemver("v0.8.0", "0.8.0")).toBe(0);
    expect(compareSemver("0.8.0-rc.1", "0.8.0")).toBe(0);
  });
});

describe("node-version", () => {
  it("warns below the floor and names both versions", () => {
    const c = nodeVersionCheck(deps({ nodeVersion: "20.9.0" }));
    expect(c.state).toBe("problem");
    expect(c.severity).toBe("warning");
    expect(c.detail).toContain("20.11");
    expect(c.detail).toContain("20.9.0");
  });
  it("is ok at or above the floor", () => {
    expect(nodeVersionCheck(deps({ nodeVersion: "20.11.0" })).state).toBe("ok");
    expect(nodeVersionCheck(deps({ nodeVersion: "22.3.1" })).state).toBe("ok");
  });
});

describe("jq-present", () => {
  it("is a fatal problem when jq is nowhere, and says what stops working", () => {
    const d = deps({ isFile: () => false, isExec: () => false });
    const c = pick(envChecks(d, [local("work", ["/h/.claude"])], []), "jq-present", "work");
    expect(c?.state).toBe("problem");
    expect(c?.severity).toBe("fatal");
    expect(c?.detail).toMatch(/metric/i);
    expect(c?.detail).toMatch(/context/i);
  });

  it("never halts the launch — a degraded install must still boot", () => {
    const d = deps({ isFile: () => false, isExec: () => false });
    expect(pick(envChecks(d, [local("work", [])], []), "jq-present")?.haltsStartup).toBe(false);
  });

  it("is ok when jq is on the server's PATH", () => {
    const d = deps({ pathEnv: "/usr/bin", isFile: (p) => p === "/usr/bin/jq", isExec: (p) => p === "/usr/bin/jq" });
    expect(pick(envChecks(d, [local("work", [])], []), "jq-present")?.state).toBe("ok");
  });

  it("is ok but says so when jq exists only outside the server's PATH", () => {
    const d = deps({
      pathEnv: "/nowhere",
      isFile: (p) => p === "/opt/homebrew/bin/jq", isExec: (p) => p === "/opt/homebrew/bin/jq",
    });
    const c = pick(envChecks(d, [local("work", [])], []), "jq-present");
    expect(c?.state).toBe("ok");
    expect(c?.detail).toContain("/opt/homebrew/bin/jq");
  });

  it("emits no jq-present row from envChecks for a remote environment — the remote adapter owns it", () => {
    const c = pick(envChecks(deps({}), [remote("box")], []), "jq-present", "box");
    expect(c).toBeUndefined();
  });
});

describe("claude-config-dirs and config-dir-exists", () => {
  it("warns on an empty list and names what stops working", () => {
    const c = pick(envChecks(deps({}), [local("work", [])], []), "claude-config-dirs", "work");
    expect(c?.state).toBe("problem");
    expect(c?.severity).toBe("warning");
    // Ruling 1: configDirsChecks (server/diagnostics/startup.ts) puts the whole consequence
    // sentence in `title` and leaves `detail: ""` — populating detail too would add an indented
    // continuation line to the startup report (render.ts), breaking parity with today's output.
    expect(c?.title).toMatch(/Remote Control/);
  });

  it("is ok when at least one dir is configured", () => {
    expect(pick(envChecks(deps({}), [local("work", ["/h/.claude"])], []), "claude-config-dirs")?.state).toBe("ok");
  });

  it("does not care whether sessions/ exists — Claude creates it on first run", () => {
    const d = deps({ isDir: (p) => p === "/h/.claude" });
    expect(pick(envChecks(d, [local("work", ["/h/.claude"])], []), "claude-config-dirs")?.state).toBe("ok");
  });

  it("warns per config dir that is not a directory — the typo case", () => {
    const d = deps({ isDir: () => false });
    const c = pick(envChecks(d, [local("work", ["/h/.clade"])], []), "config-dir-exists");
    expect(c?.state).toBe("problem");
    expect(c?.severity).toBe("warning");
    expect(c?.scope).toEqual({ kind: "configDir", envId: "work", dir: "/h/.clade" });
  });

  it("emits no config-dir-exists rows from envChecks for a remote environment — the remote adapter owns them", () => {
    const c = pick(envChecks(deps({ isDir: () => false }), [remote("box")], []), "config-dir-exists", "box");
    expect(c).toBeUndefined();
  });

  it("jqPresentCheck and configDirExistsChecks judge a remote env by deps alone once called directly", () => {
    const d = deps({ isDir: () => true, isExec: (p) => p === "/usr/bin/jq" });
    const jq = jqPresentCheck(d, remote("box"), 1);
    expect(jq.state).toBe("ok"); // found ON PATH (deps() defaults pathEnv "/usr/bin") — no remote branch left
    const dirs = configDirExistsChecks(d, remote("box"), 1);
    expect(dirs.every((c) => c.state === "ok")).toBe(true);
  });

  it("gives two config dirs two distinct keys", () => {
    const cs = envChecks(deps({}), [local("work", ["/h/.claude", "/h/.claude-x"])], [])
      .filter((c) => c.id === "config-dir-exists");
    expect(new Set(cs.map((c) => c.key)).size).toBe(2);
  });
});

describe("status-readable", () => {
  it("is n/a with no live sessions on that environment — nothing would be writing", () => {
    const c = pick(envChecks(deps({}), [local("work", ["/h/.claude"])], []), "status-readable", "work");
    expect(c?.state).toBe("n/a");
    expect(c?.detail).toMatch(/no live session/i);
  });

  it("is ok when at least one live session reports a readable status file", () => {
    const c = pick(envChecks(deps({}), [local("work", ["/h/.claude"])], [row("work", "ok")]), "status-readable");
    expect(c?.state).toBe("ok");
  });

  it("warns when live sessions exist and none has a status file", () => {
    const c = pick(envChecks(deps({}), [local("work", ["/h/.claude"])], [row("work", "not-found")]), "status-readable");
    expect(c?.state).toBe("problem");
    expect(c?.severity).toBe("warning");
  });

  it("names both consumers, so the operator knows the ctx signal dies with it", () => {
    const c = pick(envChecks(deps({}), [local("work", [])], [row("work", "not-found")]), "status-readable");
    expect(c?.detail).toMatch(/context/i);
  });

  it("stays pending while the poller has not reported a status for any session", () => {
    const c = pick(envChecks(deps({}), [local("work", [])], [row("work", null)]), "status-readable");
    expect(c?.state).toBe("pending");
  });

  it("does not blame a pane that has no session id yet — that is not a metrics failure", () => {
    // `no-session-ref` means the pane has not bound a session, so nothing SHOULD have been written.
    // Counting it as a problem paints a warning on a healthy machine every time a pane starts.
    const c = pick(envChecks(deps({}), [local("work", [])], [row("work", "no-session-ref")]), "status-readable");
    expect(c?.state).toBe("pending");
  });

  // Ruling 2: "bad-schema" and "read-error" are real metrics failures — data was expected and did
  // not arrive readable — so they count toward "problem" the same way "not-found" does. Only
  // `null` and "no-session-ref" mean "nothing should have been written yet".
  it("counts a read-error as a problem — the file was there but corral could not read it", () => {
    const c = pick(envChecks(deps({}), [local("work", [])], [row("work", "read-error")]), "status-readable");
    expect(c?.state).toBe("problem");
    expect(c?.severity).toBe("warning");
  });

  it("counts only that environment's sessions", () => {
    const cs = envChecks(deps({}), [local("a", []), local("b", [])], [row("a", "ok")]);
    expect(pick(cs, "status-readable", "a")?.state).toBe("ok");
    expect(pick(cs, "status-readable", "b")?.state).toBe("n/a");
  });
});
