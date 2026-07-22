import type { SessionRow, StatuslineData } from "@shared/schema";
import { describe, it, expect } from "vitest";

import { computeRenames } from "../server/tab-namer.ts";

function row(paneId: string, tabId: string, tab: string): SessionRow {
  return {
    env: "e1", paneId, status: "working", agent: "claude", cwd: "/x",
    tab, workspace: "ws", tabId, workspaceId: "w1", sessionId: null,
    recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null,
  };
}
function sl(session_name: string | null, name_source: string | null): StatuslineData {
  return {
    v: 1, captured_at: 1, session_id: "s", session_name, name_source,
    account: null, model: null, model_id: null,
    ctx: { pct: null, tokens: null, window: null },
    cost: { usd: null, lines_added: null, lines_removed: null },
    rate: { five_hour: null, seven_day: null },
    effort: null, thinking: null, cc_version: null,
  };
}

describe("computeRenames", () => {
  it("renames a tab whose canonical pane has a user-set name differing from the label", () => {
    const rows = [row("pA", "t1", "1")];
    const ops = computeRenames(rows, () => sl("my-name", "user"));
    expect(ops).toEqual([{ env: "e1", tabId: "t1", label: "my-name" }]);
  });

  it("skips derived and null name_source", () => {
    const rows = [row("pA", "t1", "1")];
    expect(computeRenames(rows, () => sl("auto-title", "derived"))).toEqual([]);
    expect(computeRenames(rows, () => sl("auto-title", null))).toEqual([]);
  });

  it("no-op when label already matches the name", () => {
    const rows = [row("pA", "t1", "my-name")];
    expect(computeRenames(rows, () => sl("my-name", "user"))).toEqual([]);
  });

  it("uses the lexicographically smallest paneId as the canonical pane per tab", () => {
    const rows = [row("pB", "t1", "1"), row("pA", "t1", "1")];
    const ops = computeRenames(rows, (r) => (r.paneId === "pA" ? sl("from-a", "user") : sl("from-b", "user")));
    expect(ops).toEqual([{ env: "e1", tabId: "t1", label: "from-a" }]);
  });

  it("skips rows without a tabId and empty/null session names", () => {
    const noTab: SessionRow = { ...row("pA", "", "1"), tabId: undefined };
    expect(computeRenames([noTab], () => sl("x", "user"))).toEqual([]);
    expect(computeRenames([row("pA", "t1", "1")], () => sl("", "user"))).toEqual([]);
    expect(computeRenames([row("pA", "t1", "1")], () => null)).toEqual([]);
  });
});
