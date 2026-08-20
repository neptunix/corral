import type { SessionRow, Snapshot } from "@shared/schema";
import { describe, expect, it } from "vitest";

import { ENVIRONMENTS } from "../environments.ts";
import { resolveSelf } from "../server/whoami.ts";

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
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/repo", socket: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.env.id).toBe("work-local");
  });

  it("accepts a unique match even when cwd differs (cwd is a tie-breaker, not a gate)", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/pane/cwd")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/different/cwd", socket: null,
    });
    expect(r.ok).toBe(true);
  });

  it("fails with the pane id in the reason when nothing matches", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/repo")]),
      envs: ENVIRONMENTS, paneId: "w9:p9", cwd: "/repo", socket: null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).toContain("w9:p9");
  });

  it("ignores rows belonging to remote environments", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-remote", "w1:p1", "/repo")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/repo", socket: null,
    });
    expect(r.ok).toBe(false);
  });

  it("breaks a two-env tie on an exact socket match", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/a"), row("personal-local", "w1:p1", "/b")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/nomatch",
      socket: "~/.config/herdr/sessions/personal/herdr.sock",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.env.id).toBe("personal-local");
  });

  // The normal case in practice: the MCP client always forwards HERDR_SOCKET_PATH, but
  // environments.json need not configure `socket` for every local env, so a supplied socket often
  // matches none of the candidates. That must fall through to the cwd tie-break, not report ambiguous.
  it("falls through to the cwd tie-break when a socket IS supplied but matches no configured env", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/a"), row("personal-local", "w1:p1", "/b")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/b",
      socket: "~/.config/herdr/sessions/nonexistent/herdr.sock",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.env.id).toBe("personal-local");
  });

  it("breaks a two-env tie on cwd when no socket is supplied", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/a"), row("personal-local", "w1:p1", "/b")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/b", socket: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.env.id).toBe("personal-local");
  });

  it("reports the candidates when neither socket nor cwd disambiguates", () => {
    const r = resolveSelf({
      snapshot: snapshot([row("work-local", "w1:p1", "/same"), row("personal-local", "w1:p1", "/same")]),
      envs: ENVIRONMENTS, paneId: "w1:p1", cwd: "/same", socket: null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).toContain("work-local");
    expect(r.reason).toContain("personal-local");
  });
});
