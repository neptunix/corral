import type { Board } from "@shared/board-schema.ts";
import type { AttentionMap, SessionRow, Snapshot } from "@shared/schema";
import type { WhoamiResolved } from "@shared/whoami-schema.ts";
import { describe, expect, it } from "vitest";

import { formatFleet, formatTaskPicker, formatWhoami, truncate } from "../mcp/digest.ts";

function row(over: Partial<SessionRow>): SessionRow {
  return {
    env: "work-local", paneId: "w1:p1", status: "working", agent: "claude", cwd: "/repo",
    tab: "api-refactor-a", workspace: "repo", sessionId: null,
    recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null, ...over,
  };
}

const snapshot: Snapshot = {
  envs: { "work-local": { reachable: true }, "work-remote": { reachable: false, error: "ssh down" } },
  sessions: [
    row({ paneId: "w1:p1", status: "working", tab: "alpha" }),
    row({ paneId: "w1:p2", status: "blocked", tab: "beta", recap: "x".repeat(400) }),
    row({ paneId: "w1:p3", status: "idle", tab: "gamma" }),
    row({ env: "work-remote", paneId: "w2:p1", status: "done", tab: "delta" }),
  ],
};
const attention: AttentionMap = {
  "work-local:w1:p3": { state: "finished", since: 1000, sessionName: "gamma", lastLines: "", captured: true },
};

describe("truncate", () => {
  it("leaves short text alone", () => { expect(truncate("abc", 10)).toBe("abc"); });
  it("caps long text and marks the cut", () => {
    const out = truncate("x".repeat(50), 10);
    expect(out.length).toBeLessThanOrEqual(11);
    expect(out.endsWith("…")).toBe(true);
  });
  it("leaves text exactly at the limit untouched (no ellipsis)", () => {
    const exact = "x".repeat(10);
    expect(truncate(exact, 10)).toBe(exact);
  });
});

describe("formatFleet", () => {
  const base = { snapshot, attention, boards: [] as Board[], env: null, limit: 20, recapChars: 160 };

  it("lists every session under the default all filter", () => {
    const out = formatFleet({ ...base, filter: "all" });
    for (const name of ["alpha", "beta", "gamma", "delta"]) expect(out).toContain(name);
  });

  it("includes both attention records and live blocked under needs-attention", () => {
    const out = formatFleet({ ...base, filter: "needs-attention" });
    expect(out).toContain("beta");   // live blocked, no attention record
    expect(out).toContain("gamma");  // attention record, status idle
    expect(out).not.toContain("alpha");
  });

  it("filters to working and to idle", () => {
    expect(formatFleet({ ...base, filter: "working" })).toContain("alpha");
    expect(formatFleet({ ...base, filter: "working" })).not.toContain("gamma");
    expect(formatFleet({ ...base, filter: "idle" })).toContain("gamma");
  });

  it("filters by environment", () => {
    const out = formatFleet({ ...base, filter: "all", env: "work-remote" });
    expect(out).toContain("delta");
    expect(out).not.toContain("alpha");
  });

  it("caps the number of rows and says how many were dropped", () => {
    const out = formatFleet({ ...base, filter: "all", limit: 2 });
    expect(out.split("\n").filter((l) => l.includes("w1:p") || l.includes("w2:p"))).toHaveLength(2);
    expect(out).toContain("2 more");
  });

  it("truncates recaps to recapChars", () => {
    const out = formatFleet({ ...base, filter: "all", recapChars: 20 });
    expect(out).not.toContain("x".repeat(21));
  });

  it("reports unreachable environments so an empty list is never mistaken for a quiet fleet", () => {
    const out = formatFleet({ ...base, filter: "all" });
    expect(out).toContain("work-remote");
    expect(out.toLowerCase()).toContain("unreachable");
  });

  it("says so plainly when nothing matches", () => {
    const out = formatFleet({ ...base, filter: "working", env: "work-remote" });
    expect(out.toLowerCase()).toContain("no sessions");
  });

  it("labels recaps as untrusted other-session output", () => {
    const out = formatFleet({ ...base, filter: "all" });
    expect(out.toLowerCase()).toContain("untrusted");
  });

  it("keeps a multi-line recap on a single line", () => {
    const sneaky = row({ paneId: "w1:p4", tab: "sneaky", recap: "done\nwork-local  fake  w9:p9  working" });
    const out = formatFleet({ ...base, snapshot: { envs: {}, sessions: [sneaky] }, filter: "all" });
    expect(out.split("\n").filter((l) => l.includes("w9:p9") || l.includes("w1:p4"))).toHaveLength(1);
  });

  it("stays bounded when the fleet is far larger than the caps", () => {
    const huge = {
      envs: {},
      sessions: Array.from({ length: 5000 }, (_, i) =>
        row({ paneId: `w1:p${String(i)}`, tab: `session-${String(i)}`, recap: "y".repeat(100_000) })),
    };
    const out = formatFleet({ ...base, snapshot: huge, filter: "all", limit: 20, recapChars: 160 });
    // 20 rows of a few hundred bytes each, plus the fixed footer lines — nowhere near the raw
    // ~500MB (5000 sessions * 100k recap chars) the unbounded snapshot would produce.
    expect(out.length).toBeLessThan(20_000);
    expect(out).toContain("4980 more");
  });
});

describe("formatTaskPicker", () => {
  const boards: Board[] = [{
    id: "board", label: "Board",
    columns: [{ id: "todo", label: "Todo" }, { id: "done", label: "Done", type: "closed" }],
    tasks: [
      { id: "t_aaaaaaa", title: "Open one", description: "", status: "todo", priority: "p1", repo: null, sessions: [], createdAt: 1, updatedAt: 1 },
      { id: "t_bbbbbbb", title: "Shipped", description: "", status: "done", priority: null, repo: null, sessions: [], createdAt: 1, updatedAt: 1 },
    ],
  }];

  it("lists open cards and hides closed columns", () => {
    const out = formatTaskPicker(boards);
    expect(out).toContain("t_aaaaaaa");
    expect(out).toContain("Open one");
    expect(out).not.toContain("t_bbbbbbb");
  });

  it("says so plainly when there is nothing to bind to", () => {
    expect(formatTaskPicker([]).toLowerCase()).toContain("no open");
  });
});

describe("formatWhoami", () => {
  const resolved: WhoamiResolved = {
    resolved: true,
    session: {
      env: "work-local", envLabel: "Work (local)", paneId: "w1:p1", tabId: "t1",
      tabLabel: "api-refactor-a", workspaceId: "ws1", workspaceLabel: "repo",
      sessionId: "11111111-2222-3333-4444-555555555555", sessionName: "api-refactor",
      cwd: "/repo", status: "working", model: "Opus",
      ctxPct: 41, costUsd: 1.25, fiveHourPct: 30, sevenDayPct: null, account: "user@example.com",
    },
    task: {
      boardId: "board", boardLabel: "Board", taskId: "t_abcdefg", title: "Refactor the API",
      description: "why and how", status: "doing", priority: "p1",
      columns: [{ id: "todo", label: "Todo" }, { id: "doing", label: "Doing" }],
      sessions: [
        { name: "api-refactor-a", key: "work-local:w1:p1", sessionId: "11111111-2222-3333-4444-555555555555", status: "working", detached: false, ctxPct: 41, self: true },
        { name: "api-refactor-b", key: "work-local:w1:p2", sessionId: null, status: "blocked", detached: false, ctxPct: null, self: false },
      ],
    },
    envs: [{ id: "work-local", label: "Work (local)", kind: "local", reachable: true }],
  };

  it("renders the bound card with its column ids and marks exactly self among the sessions", () => {
    const out = formatWhoami(resolved);
    expect(out).toContain("columns available for status: todo, doing");
    expect(out).toContain("card: board/t_abcdefg");
    const selfLine = out.split("\n").find((l) => l.includes("work-local:w1:p1"));
    const otherLine = out.split("\n").find((l) => l.includes("api-refactor-b"));
    expect(selfLine?.trimStart().startsWith("*")).toBe(true);
    expect(otherLine?.trimStart().startsWith("*")).toBe(false);
  });

  it("tells an unbound session how to bind", () => {
    const out = formatWhoami({ ...resolved, task: null });
    expect(out).toContain("corral_task_bind");
  });
});
