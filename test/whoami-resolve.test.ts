import type { SessionRow, Snapshot } from "@shared/schema";
import { describe, expect, it } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { ENVIRONMENTS } from "../environments.ts";
import type { PaneIdentity } from "../server/whoami.ts";
import { resolveSelf, resolveSelfViaPane } from "../server/whoami.ts";

function row(env: string, paneId: string, cwd: string): SessionRow {
  return {
    env, paneId, status: "working", agent: "claude", cwd, tab: "t", workspace: "w",
    sessionId: null, recap: null, recapAt: null, recapStatus: null, recapSource: null,
    statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
  };
}
const snapshot = (sessions: SessionRow[]): Snapshot => ({ envs: {}, sessions });

describe("resolveSelf", () => {
  it("resolves a unique paneId match", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/repo")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/repo", socket: null, ambientSocket: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.env.id).toBe("work-local");
  });

  it("accepts a unique match even when cwd differs (cwd is a tie-breaker, not a gate)", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/pane/cwd")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/different/cwd", socket: null, ambientSocket: null,
    });
    expect(r.ok).toBe(true);
  });

  it("fails with the pane id in the reason when nothing matches", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/repo")]),
      envs: ENVIRONMENTS, paneId: "w9:p9", cwd: "/repo", socket: null, ambientSocket: null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).toContain("w9:p9");
  });

  it("ignores rows belonging to remote environments", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-remote", "w1:p1", "/repo")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/repo", socket: null, ambientSocket: null,
    });
    expect(r.ok).toBe(false);
  });

  it("breaks a two-env tie on an exact socket match", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/a"), row("personal-local", "w1:p1", "/b")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/nomatch",
      socket: "~/.config/herdr/sessions/personal/herdr.sock", ambientSocket: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.env.id).toBe("personal-local");
  });

  it("breaks a two-env tie on cwd when no socket is supplied", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/a"), row("personal-local", "w1:p1", "/b")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/b", socket: null, ambientSocket: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.env.id).toBe("personal-local");
  });

  it("reports the candidates when neither socket nor cwd disambiguates", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/same"), row("personal-local", "w1:p1", "/same")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/same", socket: null, ambientSocket: null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).toContain("work-local");
    expect(r.reason).toContain("personal-local");
  });

  // Regression for the T4 misidentification: a colliding pane id from ANOTHER herdr server (a remote
  // env's pane, or any process sending a socket path corral never configured) must never fall back to
  // the sole local candidate sharing that pane id. Before the fix, `only` returned before the socket
  // hint was even inspected.
  it("reports unresolved, not the sole local candidate, when the socket hint matches no local env", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/repo")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/repo",
      socket: "/repo/path/to/a/different/herdr/session.sock", ambientSocket: null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected the mismatched socket to be refused");
    expect(r.reason).toContain("w1:p1");
    expect(r.reason.toLowerCase()).toContain("socket");
  });

  it("still refuses a mismatched socket when it collides with a DIFFERENT configured env's socket", () => {
    // personal-local's own socket does not match, so it must not be picked either — only an exact
    // match (or the sole local candidate's own effective socket) counts.
    const r = resolveSelf({
      snapshot: snapshot([row("personal-local", "w1:p1", "/repo")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/repo",
      socket: "/repo/path/to/a/different/herdr/session.sock", ambientSocket: null,
    });
    expect(r.ok).toBe(false);
  });

  // "work-local" configures no `socket` in the test fixture, so it runs on herdr's default socket —
  // whatever HERDR_SOCKET_PATH corral itself was launched under. A pane in that env forwards that same
  // ambient value as its own hint, and it must still resolve.
  it("matches a socket-less local env against the ambient default socket", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/repo")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/repo",
      socket: "/run/user/1000/herdr/default.sock", ambientSocket: "/run/user/1000/herdr/default.sock",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.env.id).toBe("work-local");
  });

  it("refuses a socket-less local env when the hint does not match the ambient default either", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/repo")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/repo",
      socket: "/some/other/herdr/session.sock", ambientSocket: "/run/user/1000/herdr/default.sock",
    });
    expect(r.ok).toBe(false);
  });
});

describe("resolveSelfViaPane", () => {
  const pane: PaneIdentity = {
    paneId: "w1:p1", tabId: "tab1", tabLabel: "t", workspaceId: "ws1", workspaceLabel: "w", cwd: "/repo",
  };

  it("resolves a fresh socket-less pane against the ambient default socket", async () => {
    const r = await resolveSelfViaPane({
      envs: ENVIRONMENTS, paneId: "w1:p1",
      socket: "/run/user/1000/herdr/default.sock", ambientSocket: "/run/user/1000/herdr/default.sock",
      lookup: (env, id) => Promise.resolve(env.id === "work-local" ? { ...pane, paneId: id } : null),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.env.id).toBe("work-local");
  });

  // The security-relevant part of the fix: a fresh pane's own herdr lookup must never even be tried
  // for an env whose effective socket does not match a supplied hint — the pane-id-only lookup is
  // exactly what let a colliding remote pane resolve as the wrong local session.
  it("never calls lookup for an env whose effective socket does not match the hint", async () => {
    const calls: string[] = [];
    const r = await resolveSelfViaPane({
      envs: ENVIRONMENTS, paneId: "w1:p1",
      socket: "/repo/path/to/a/different/herdr/session.sock", ambientSocket: null,
      lookup: (env, id) => { calls.push(env.id); return Promise.resolve({ ...pane, paneId: id }); },
    });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("still tries every local environment when no socket hint is supplied", async () => {
    const calls: string[] = [];
    const r = await resolveSelfViaPane({
      envs: ENVIRONMENTS, paneId: "w1:p1", socket: null, ambientSocket: null,
      lookup: (env: HerdrEnv, id) => { calls.push(env.id); return Promise.resolve(env.id === "personal-local" ? { ...pane, paneId: id } : null); },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.env.id).toBe("personal-local");
    expect(calls.length).toBeGreaterThan(1);
  });
});
