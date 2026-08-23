import type { Board, SessionLink } from "@shared/board-schema.ts";
import type { SessionRow, Snapshot } from "@shared/schema";
import { describe, expect, it } from "vitest";

import { ENVIRONMENTS } from "../environments.ts";
import { cardSignal } from "../server/card-signal.ts";

const SID = "11111111-2222-3333-4444-555555555555";

function row(over: Partial<SessionRow>): SessionRow {
  return {
    env: "work-local", paneId: "w1:p1", status: "working", agent: "claude", cwd: "/repo",
    tab: "t", workspace: "w", tabId: "tab1", workspaceId: "ws1",
    sessionId: SID, recap: null, recapAt: null, recapStatus: null, recapSource: null,
    statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null,
    remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null, ...over,
  };
}

function snapshot(sessions: SessionRow[]): Snapshot {
  return { envs: {}, sessions };
}

function link(over: Partial<SessionLink>): SessionLink {
  return {
    env: "work-local", paneId: "w1:p1", tabId: "tab1", tabLabel: "t", workspaceId: "ws1",
    workspaceLabel: "w", name: "a", cwdSnapshot: "/repo", sessionId: SID, ...over,
  };
}

function board(over: Partial<Board>): Board {
  return {
    id: "b", label: "Board",
    columns: [{ id: "todo", label: "Todo" }, { id: "done", label: "Done", type: "closed" }],
    tasks: [], spawnPresets: [], defaultSpawnPresetId: null, ...over,
  };
}

const pane = { paneId: "w1:p1", cwd: "/repo", socket: null };

describe("cardSignal", () => {
  it("reports empty for a bound task with a blank description", () => {
    const b = board({ tasks: [{
      id: "t1", title: "T", description: "", status: "todo", priority: null,
      createdAt: 1, updatedAt: 1, sessions: [link({})],
    }] });
    const out = cardSignal([b], snapshot([row({})]), ENVIRONMENTS, pane);
    expect(out.empty).toBe(true);
  });

  it("reports empty for a whitespace-only description", () => {
    const b = board({ tasks: [{
      id: "t1", title: "T", description: "   \n\t  ", status: "todo", priority: null,
      createdAt: 1, updatedAt: 1, sessions: [link({})],
    }] });
    const out = cardSignal([b], snapshot([row({})]), ENVIRONMENTS, pane);
    expect(out.empty).toBe(true);
  });

  it("reports not-empty for a bound task with a real description", () => {
    const b = board({ tasks: [{
      id: "t1", title: "T", description: "the actual task", status: "todo", priority: null,
      createdAt: 1, updatedAt: 1, sessions: [link({})],
    }] });
    const out = cardSignal([b], snapshot([row({})]), ENVIRONMENTS, pane);
    expect(out.empty).toBe(false);
  });

  it("reports not-empty when the pane cannot be resolved (not_found)", () => {
    const out = cardSignal([], snapshot([]), ENVIRONMENTS, pane);
    expect(out.empty).toBe(false);
  });

  it("reports not-empty when the pane is ambiguous across environments", () => {
    const twoLocal = ENVIRONMENTS.filter((e) => e.kind === "local").slice(0, 2);
    const rows = twoLocal.map((e) => row({ env: e.id, cwd: "/nomatch" }));
    const out = cardSignal([], snapshot(rows), ENVIRONMENTS, { paneId: "w1:p1", cwd: "/other", socket: null });
    expect(out.empty).toBe(false);
  });

  it("matches a link with a null sessionId on its pane", () => {
    const b = board({ tasks: [{
      id: "t1", title: "T", description: "", status: "todo", priority: null,
      createdAt: 1, updatedAt: 1, sessions: [link({ sessionId: null })],
    }] });
    const out = cardSignal([b], snapshot([row({})]), ENVIRONMENTS, pane);
    expect(out.empty).toBe(true);
  });

  it("matches a link whose pane churned via the stable sessionId", () => {
    const b = board({ tasks: [{
      id: "t1", title: "T", description: "", status: "todo", priority: null,
      createdAt: 1, updatedAt: 1, sessions: [link({ paneId: "old:p9", sessionId: SID })],
    }] });
    // The live row now sits on a different paneId, matching what the caller asks about.
    const out = cardSignal([b], snapshot([row({ paneId: "w1:p1", sessionId: SID })]), ENVIRONMENTS, pane);
    expect(out.empty).toBe(true);
  });

  it("finds a blank card sitting in a closed column", () => {
    const b = board({ tasks: [{
      id: "t1", title: "T", description: "", status: "done", priority: null,
      createdAt: 1, updatedAt: 1, sessions: [link({})],
    }] });
    const out = cardSignal([b], snapshot([row({})]), ENVIRONMENTS, pane);
    expect(out.empty).toBe(true);
  });

  it("resolves through a second link on the same card", () => {
    const b = board({ tasks: [{
      id: "t1", title: "T", description: "", status: "todo", priority: null,
      createdAt: 1, updatedAt: 1,
      sessions: [
        link({ paneId: "w1:p2", sessionId: "99999999-8888-7777-6666-555555555555", name: "other" }),
        link({}),
      ],
    }] });
    const out = cardSignal([b], snapshot([row({})]), ENVIRONMENTS, pane);
    expect(out.empty).toBe(true);
  });

  it("reports not-empty with an empty board list", () => {
    const out = cardSignal([], snapshot([row({})]), ENVIRONMENTS, pane);
    expect(out.empty).toBe(false);
  });
});
