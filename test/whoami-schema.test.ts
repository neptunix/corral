import { WhoamiResponseSchema } from "@shared/whoami-schema.ts";
import { describe, expect, it } from "vitest";

const resolved = {
  resolved: true,
  session: {
    env: "work-local", envLabel: "Work (local)", paneId: "w1:p1",
    tabId: "t1", tabLabel: "api-refactor-a", workspaceId: "ws1", workspaceLabel: "repo",
    sessionId: "11111111-2222-3333-4444-555555555555", sessionName: "api-refactor",
    cwd: "/repo/path", status: "working", model: "Opus",
    ctxPct: 41, costUsd: 1.25, fiveHourPct: 30, sevenDayPct: null, account: "user@example.com",
  },
  task: {
    boardId: "board", boardLabel: "Board", taskId: "t_abcdefg",
    title: "Refactor the API", description: "why and how", status: "doing", priority: "p1",
    columns: [{ id: "todo", label: "Todo" }, { id: "doing", label: "Doing" }],
    sessions: [{
      name: "api-refactor-a", key: "work-local:w1:p1",
      sessionId: "11111111-2222-3333-4444-555555555555",
      status: "working", detached: false, ctxPct: 41, self: true,
    }],
  },
  envs: [{ id: "work-local", label: "Work (local)", kind: "local", reachable: true }],
};

describe("whoami schema", () => {
  it("parses a resolved payload and keeps the discriminant", () => {
    const parsed = WhoamiResponseSchema.parse(resolved);
    expect(parsed.resolved).toBe(true);
    if (!parsed.resolved) throw new Error("expected resolved");
    expect(parsed.task?.sessions[0]?.self).toBe(true);
    expect(parsed.session.ctxPct).toBe(41);
  });

  // An MCP client talks to whatever corral server happens to be running, which may predate this
  // field. Requiring it would fail EVERY card read against an older server rather than lose one
  // informational string — the fixture above deliberately omits it.
  it("accepts a card session from a server that does not send claudeName yet", () => {
    const parsed = WhoamiResponseSchema.parse(resolved);
    if (!parsed.resolved) throw new Error("expected resolved");
    expect(parsed.task?.sessions[0]?.claudeName).toBeNull();
  });

  it("parses an unresolved payload carrying a reason and the env list", () => {
    const parsed = WhoamiResponseSchema.parse({
      resolved: false,
      reason: "no live session at pane w9:p9 in any local environment",
      envs: [{ id: "work-local", label: "Work (local)", kind: "local", reachable: false }],
    });
    if (parsed.resolved) throw new Error("expected unresolved");
    expect(parsed.reason).toContain("w9:p9");
    expect(parsed.envs).toHaveLength(1);
  });

  it("rejects an unknown env kind", () => {
    const bad = { ...resolved, envs: [{ id: "x", label: "X", kind: "cloud", reachable: true }] };
    expect(WhoamiResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a null task for an unbound session", () => {
    const parsed = WhoamiResponseSchema.parse({ ...resolved, task: null });
    if (!parsed.resolved) throw new Error("expected resolved");
    expect(parsed.task).toBeNull();
  });
});
