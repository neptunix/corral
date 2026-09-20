import { describe, expect, it } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import type { CorralClient } from "../mcp/client.ts";
import type { Identity } from "../mcp/identity.ts";
import type { SessionDeps } from "../mcp/tools/session.ts";
import { closeHandler, spawnHandler } from "../mcp/tools/session.ts";
import { parsePreamble } from "../server/remote-mcp/preamble.ts";
import { resolveSelfInEnv, resolveSelfInEnvViaPane } from "../server/self-in-env.ts";
import type { PaneIdentity } from "../server/whoami.ts";

const remote: Extract<HerdrEnv, { kind: "remote" }> = {
  id: "envA", label: "Env A", kind: "remote", sshHost: "host1", socket: "/s.sock", herdrBin: "/herdr",
  claudeConfigDirs: [], spawnCommand: "claude", repos: {},
};

function row(over: { env: string; paneId: string; cwd: string }) {
  return {
    ...over,
    status: "idle", agent: "claude", tab: "t", workspace: "w", tabId: "w1", workspaceId: "w1",
    sessionId: null, recap: null, recapAt: null, recapStatus: null, recapSource: null,
    statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null,
    remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
  };
}

describe("resolveSelfInEnv", () => {
  it("resolves within the pinned environment and ignores an identical pane id elsewhere", () => {
    const snapshot = {
      at: 0, envs: {},
      sessions: [row({ env: "local1", paneId: "w1:p1", cwd: "/a" }), row({ env: "envA", paneId: "w1:p1", cwd: "/b" })],
    };
    const res = resolveSelfInEnv({ snapshot, env: remote, paneId: "w1:p1", cwd: "/b" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.row.cwd).toBe("/b");
  });

  it("never reaches outside the pinned environment, even when only one pane carries the id", () => {
    const snapshot = { at: 0, envs: {}, sessions: [row({ env: "local1", paneId: "w1:p1", cwd: "/a" })] };
    const res = resolveSelfInEnv({ snapshot, env: remote, paneId: "w1:p1", cwd: "/a" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
  });

  it("breaks a stale-snapshot duplicate on cwd, and says ambiguous when it cannot", () => {
    const dup = {
      at: 0, envs: {},
      sessions: [row({ env: "envA", paneId: "w1:p1", cwd: "/a" }), row({ env: "envA", paneId: "w1:p1", cwd: "/b" })],
    };
    expect(resolveSelfInEnv({ snapshot: dup, env: remote, paneId: "w1:p1", cwd: "/b" }).ok).toBe(true);
    const tie = resolveSelfInEnv({ snapshot: dup, env: remote, paneId: "w1:p1", cwd: "/elsewhere" });
    expect(tie.ok).toBe(false);
    if (!tie.ok) expect(tie.code).toBe("ambiguous");
  });

  it("synthesizes a starting row for a pane whose Claude has not registered yet", async () => {
    const pane: PaneIdentity = {
      paneId: "w1:p9", tabId: "t1", tabLabel: "tab", workspaceId: "w1", workspaceLabel: "ws", cwd: "/fresh",
    };
    const res = await resolveSelfInEnvViaPane({ env: remote, paneId: "w1:p9", lookup: () => Promise.resolve(pane) });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.env.id).toBe("envA");
      expect(res.row.sessionId).toBeNull();
    }
  });
});

describe("preamble", () => {
  it("accepts the shim's line", () => {
    expect(parsePreamble(JSON.stringify({ v: 1, paneId: "w1:p1", cwd: "/repo" })).ok).toBe(true);
  });

  it("refuses a malformed pane id, an unknown version, and extra fields", () => {
    expect(parsePreamble(JSON.stringify({ v: 1, paneId: "-x", cwd: "/r" })).ok).toBe(false);
    expect(parsePreamble(JSON.stringify({ v: 2, paneId: "w1:p1", cwd: "/r" })).ok).toBe(false);
    // A `socket` field would be an environment hint, and the environment is not the caller's to say.
    expect(parsePreamble(JSON.stringify({ v: 1, paneId: "w1:p1", cwd: "/r", socket: "/x" })).ok).toBe(false);
    expect(parsePreamble("nonsense").ok).toBe(false);
  });
});

const card = { boardId: "b1", taskId: "t1", title: "Card", status: "doing", columns: [], description: "", logCount: 0, sessions: [] };

function deps(over: Partial<SessionDeps> = {}): SessionDeps {
  const me = {
    resolved: true as const,
    session: { env: "envA", paneId: "w1:p1", sessionId: null },
    task: { ...card, sessions: [{ key: "local1:w2:p2", self: false, sessionId: null }] },
  };
  const identity: Identity = {
    // The handlers read only `session` and `task`; the cast-free way to say that is a local shape.
    load: () => Promise.resolve(JSON.parse(JSON.stringify(me))),
    requireCard: () => Promise.resolve(JSON.parse(JSON.stringify(me.task))),
  };
  // Every method rejects: these tests assert the handlers REFUSE before any call reaches corral, so
  // a reached call is a failed test rather than a mock to maintain.
  const nope = () => Promise.reject(new Error("must not be called"));
  const client: CorralClient = {
    whoami: nope, attention: nope, state: nope, boards: nope, board: nope, appendLog: nope,
    createTask: nope, patchTask: nope, attach: nope, spawn: nope, closeSession: nope, spawnTargets: nope,
  };
  return { client, identity, envScope: "envA", ...over };
}

describe("environment scope on the remote surface", () => {
  it("refuses a spawn onto another environment", async () => {
    const out = await spawnHandler(deps(), { brief: "do the thing", env: "local1", repo: "r" });
    expect(out).toContain("refusing to spawn");
    expect(out).toContain("envA");
  });

  it("refuses closing a session on another environment, even on the same card", async () => {
    const out = await closeHandler(deps(), { target: "local1:w2:p2" });
    expect(out).toContain("refusing to close");
  });

  it("leaves an unscoped session alone", async () => {
    const out = await spawnHandler(deps({ envScope: undefined }), { brief: "b", env: "local1", repo: "r" });
    expect(out).not.toContain("refusing to spawn");
  });
});
