import type { Board, SessionLink, Task } from "@shared/board-schema.ts";
import type { SessionRow } from "@shared/schema";
import { describe, it, expect } from "vitest";

import { findCard, isSessionBound, resolveLinkIndex } from "../server/session-binding.ts";

function link(o: { paneId: string; sessionId: string | null; env?: string }): SessionLink {
  return {
    env: o.env ?? "work-local", paneId: o.paneId, tabId: "", tabLabel: "", workspaceId: "",
    workspaceLabel: "", name: o.paneId, cwdSnapshot: "", sessionId: o.sessionId,
  };
}
const OLD = "aaaaaaaa-1111-2222-3333-444444444444";
const NEW = "bbbbbbbb-5555-6666-7777-888888888888";

describe("isSessionBound — exact per-link complement of buildUnassigned", () => {
  it("a null-UUID link claims its pane (legacy)", () => {
    const links = [link({ paneId: "pX", sessionId: null })];
    expect(isSessionBound(links, { env: "work-local", paneId: "pX", liveSessionId: NEW })).toBe(true);
    expect(isSessionBound(links, { env: "work-local", paneId: "pY", liveSessionId: NEW })).toBe(false);
  });

  it("a UUID link claims its session regardless of pane", () => {
    const links = [link({ paneId: "pX", sessionId: OLD })];
    expect(isSessionBound(links, { env: "work-local", paneId: "pZ", liveSessionId: OLD })).toBe(true);
    expect(isSessionBound(links, { env: "work-local", paneId: "pX", liveSessionId: NEW })).toBe(false);
  });

  it("a stale non-null pane-mate does NOT bind the restarted session (the bug)", () => {
    const links = [link({ paneId: "pX", sessionId: OLD })];
    expect(isSessionBound(links, { env: "work-local", paneId: "pX", liveSessionId: NEW })).toBe(false);
  });

  it("the /new null window: a null liveSessionId never matches a non-null pane-mate", () => {
    const links = [link({ paneId: "pX", sessionId: OLD })];
    expect(isSessionBound(links, { env: "work-local", paneId: "pX", liveSessionId: null })).toBe(false);
  });

  it("is env-scoped", () => {
    const links = [link({ paneId: "pX", sessionId: null, env: "personal-local" })];
    expect(isSessionBound(links, { env: "work-local", paneId: "pX", liveSessionId: null })).toBe(false);
  });
});

describe("resolveLinkIndex — address one stored link", () => {
  it("prefers an explicit sessionId over paneId", () => {
    const links = [link({ paneId: "pX", sessionId: OLD }), link({ paneId: "pX", sessionId: NEW })];
    expect(resolveLinkIndex(links, { env: "work-local", paneId: "pX", sessionId: NEW, liveSessionId: null })).toBe(1);
  });

  it("falls back to paneId when no sessionId is given", () => {
    const links = [link({ paneId: "pX", sessionId: OLD })];
    expect(resolveLinkIndex(links, { env: "work-local", paneId: "pX", sessionId: null, liveSessionId: null })).toBe(0);
  });

  it("churn-heals by the live row's sessionId when the paneId misses", () => {
    const links = [link({ paneId: "old:p", sessionId: OLD })];
    expect(resolveLinkIndex(links, { env: "work-local", paneId: "new:p", sessionId: null, liveSessionId: OLD })).toBe(0);
  });

  it("returns -1 when an explicit sessionId matches nothing (NO paneId fallthrough)", () => {
    // A stale-frame sid must not resolve to the same-pane sibling — close/resume would hit the wrong one.
    const links = [link({ paneId: "pX", sessionId: OLD })];
    expect(resolveLinkIndex(links, { env: "work-local", paneId: "pX", sessionId: "nomatch", liveSessionId: null })).toBe(-1);
  });

  it("returns -1 on no match", () => {
    const links = [link({ paneId: "pX", sessionId: OLD })];
    expect(resolveLinkIndex(links, { env: "work-local", paneId: "pY", sessionId: null, liveSessionId: null })).toBe(-1);
  });
});

function row(paneId: string): SessionRow {
  return {
    env: "work-local", paneId, status: "working", agent: "claude", cwd: "/repo",
    tab: "t", workspace: "w", tabId: "tab1", workspaceId: "ws1",
    sessionId: null, recap: null, recapAt: null, recapStatus: null, recapSource: null,
    statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null,
    remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
  };
}

function task(id: string, sessions: SessionLink[]): Task {
  return { id, title: "T", description: "", status: "todo", priority: null, createdAt: 1, updatedAt: 1, sessions };
}

function board(id: string, tasks: Task[]): Board {
  return { id, label: id, columns: [{ id: "todo", label: "Todo" }], tasks, spawnPresets: [], defaultSpawnPresetId: null };
}

describe("findCard — walks every board and every task, not just the first", () => {
  it("skips a non-matching board to find the match in a later one", () => {
    const other = board("other", [task("t-other", [link({ paneId: "pX", sessionId: null })])]);
    const mine = board("mine", [task("t-mine", [link({ paneId: "pY", sessionId: null })])]);
    const found = findCard([other, mine], row("pY"));
    expect(found?.board.id).toBe("mine");
    expect(found?.task.id).toBe("t-mine");
  });

  it("skips a non-matching task to find the match in a later task on the same board", () => {
    const b = board("b", [
      task("t1", [link({ paneId: "pX", sessionId: null })]),
      task("t2", [link({ paneId: "pY", sessionId: null })]),
    ]);
    const found = findCard([b], row("pY"));
    expect(found?.task.id).toBe("t2");
  });

  it("returns undefined when no board or task matches", () => {
    const b = board("b", [task("t1", [link({ paneId: "pX", sessionId: null })])]);
    expect(findCard([b], row("pZ"))).toBeUndefined();
  });
});
