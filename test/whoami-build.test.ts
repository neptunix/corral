import type { Board } from "@shared/board-schema.ts";
import type { SessionRow, Snapshot, StatuslineData } from "@shared/schema";
import { describe, expect, it } from "vitest";

import { ENVIRONMENTS } from "../environments.ts";
import { buildWhoami } from "../server/whoami.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const SID_B = "99999999-8888-7777-6666-555555555555";

const statusline: StatuslineData = {
  v: 1, captured_at: 9, session_id: SID,
  account: { uuid: "u1", email: "user@example.com", org: "Org", tier: "t" },
  model: "Opus", model_id: null,
  ctx: { pct: 41, tokens: null, window: null },
  cost: { usd: 1.25, lines_added: null, lines_removed: null },
  rate: { five_hour: { used_percentage: 30, resets_at: 1 }, seven_day: null },
  effort: null, thinking: null, cc_version: null,
};

function row(over: Partial<SessionRow>): SessionRow {
  return {
    env: "work-local", paneId: "w1:p1", status: "working", agent: "claude", cwd: "/repo",
    tab: "api-refactor-a", workspace: "repo", tabId: "tab1", workspaceId: "ws1",
    sessionId: SID, recap: null, recapAt: null, recapStatus: null, recapSource: null,
    statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null, ...over,
  };
}

const me = row({ statusline, statuslineStatus: "ok", claudeName: "api-refactor", claudeNameUserSet: true });
const sibling = row({ paneId: "w1:p2", sessionId: SID_B, status: "blocked", tab: "api-refactor-b" });

const snapshot: Snapshot = {
  envs: { "work-local": { reachable: true }, "personal-local": { reachable: false } },
  sessions: [me, sibling],
};

const board: Board = {
  id: "board", label: "Board",
  columns: [
    { id: "todo", label: "Todo" },
    { id: "doing", label: "Doing", type: "in-progress" },
    { id: "done", label: "Done", type: "closed" },
  ],
  tasks: [{
    id: "t_abcdefg", title: "Refactor the API", description: "why and how",
    status: "doing", priority: "p1", createdAt: 1, updatedAt: 2, log: [],
    sessions: [
      { env: "work-local", paneId: "w1:p1", tabId: "tab1", tabLabel: "api-refactor-a", workspaceId: "ws1", workspaceLabel: "repo", name: "api-refactor-a", cwdSnapshot: "/repo", sessionId: SID },
      { env: "work-local", paneId: "w1:p2", tabId: "tab2", tabLabel: "api-refactor-b", workspaceId: "ws1", workspaceLabel: "repo", name: "api-refactor-b", cwdSnapshot: "/repo", sessionId: SID_B },
      { env: "work-local", paneId: "w1:p9", tabId: "tab9", tabLabel: "api-refactor-c", workspaceId: "ws1", workspaceLabel: "repo", name: "api-refactor-c", cwdSnapshot: "/repo", sessionId: "00000000-0000-4000-8000-000000000000" },
    ],
  }],
  spawnPresets: [], defaultSpawnPresetId: null,
};

describe("buildWhoami", () => {
  it("passes an unresolved resolution through, still carrying the env list", () => {
    const out = buildWhoami({
      resolution: { ok: false, code: "not_found", reason: "no live session at pane w9:p9 in any local environment" },
      envs: ENVIRONMENTS, snapshot, boards: [board],
    });
    if (out.resolved) throw new Error("expected unresolved");
    expect(out.reason).toContain("w9:p9");
    expect(out.envs.length).toBe(ENVIRONMENTS.length);
  });

  it("projects statusline numbers onto the session block", () => {
    const localEnv = ENVIRONMENTS.find((e) => e.id === "work-local");
    if (localEnv === undefined) throw new Error("fixture missing work-local");
    const out = buildWhoami({
      resolution: { ok: true, env: localEnv, row: me }, envs: ENVIRONMENTS, snapshot, boards: [board],
    });
    if (!out.resolved) throw new Error("expected resolved");
    expect(out.session.ctxPct).toBe(41);
    expect(out.session.costUsd).toBe(1.25);
    expect(out.session.fiveHourPct).toBe(30);
    expect(out.session.sevenDayPct).toBeNull();
    expect(out.session.account).toBe("user@example.com");
    expect(out.session.sessionName).toBe("api-refactor");
    expect(out.session.envLabel).toBe("Work (local)");
  });

  it("reports env reachability for every configured environment", () => {
    const localEnv = ENVIRONMENTS.find((e) => e.id === "work-local");
    if (localEnv === undefined) throw new Error("fixture missing work-local");
    const out = buildWhoami({
      resolution: { ok: true, env: localEnv, row: me }, envs: ENVIRONMENTS, snapshot, boards: [board],
    });
    if (!out.resolved) throw new Error("expected resolved");
    const byId = new Map(out.envs.map((e) => [e.id, e]));
    expect(byId.get("work-local")?.reachable).toBe(true);
    expect(byId.get("personal-local")?.reachable).toBe(false);
    expect(byId.get("work-remote")?.reachable).toBe(false); // absent from snapshot.envs
    expect(byId.get("work-remote")?.kind).toBe("remote");
  });

  it("finds the card, exposes its column ids, and marks self among the attached sessions", () => {
    const localEnv = ENVIRONMENTS.find((e) => e.id === "work-local");
    if (localEnv === undefined) throw new Error("fixture missing work-local");
    const out = buildWhoami({
      resolution: { ok: true, env: localEnv, row: me }, envs: ENVIRONMENTS, snapshot, boards: [board],
    });
    if (!out.resolved) throw new Error("expected resolved");
    expect(out.task?.taskId).toBe("t_abcdefg");
    expect(out.task?.columns.map((c) => c.id)).toEqual(["todo", "doing", "done"]);
    // `closed` is what lets a session tell a column that ENDS the work from one that does not — the
    // one distinction it cannot make from an id or a label.
    expect(out.task?.columns.map((c) => c.closed)).toEqual([false, false, true]);

    const sessions = out.task?.sessions ?? [];
    expect(sessions.map((s) => s.name)).toEqual(["api-refactor-a", "api-refactor-b", "api-refactor-c"]);
    expect(sessions.filter((s) => s.self).map((s) => s.key)).toEqual(["work-local:w1:p1"]);

    const b = sessions.find((s) => s.name === "api-refactor-b");
    expect(b?.status).toBe("blocked");
    expect(b?.detached).toBe(false);

    // A link with no live row is detached, and reports no status of its own.
    const c = sessions.find((s) => s.name === "api-refactor-c");
    expect(c?.detached).toBe(true);
    expect(c?.status).toBe("detached");
    expect(c?.ctxPct).toBeNull();
  });

  // claudeName is the address a peer is messaged by; the card's own `name` is only the label corral
  // was asked for. The fixture already has all three states — the two names diverge on the self row
  // (link `api-refactor-a` vs captured `api-refactor`, the shape a resumed session produces), the
  // sibling is live with no capture, and the third link has no live row at all.
  it("reports the captured Claude name per card session, and null when there is none", () => {
    const localEnv = ENVIRONMENTS.find((e) => e.id === "work-local");
    if (localEnv === undefined) throw new Error("fixture missing work-local");
    const out = buildWhoami({
      resolution: { ok: true, env: localEnv, row: me },
      envs: ENVIRONMENTS, snapshot, boards: [board],
    });
    if (!out.resolved) throw new Error("expected resolved");
    const sessions = out.task?.sessions ?? [];
    expect(sessions.find((s) => s.name === "api-refactor-a")?.claudeName).toBe("api-refactor");
    expect(sessions.find((s) => s.name === "api-refactor-b")?.claudeName).toBeNull();
    expect(sessions.find((s) => s.name === "api-refactor-c")?.claudeName).toBeNull();
  });

  // Two fields, two policies, deliberately: `sessionName` is STORED (the MCP attach writes it into
  // SessionLink.name), so it is gated on claudeNameUserSet; the card's `claudeName` is only shown, so
  // it reports whatever Claude currently calls the session, auto-derived or not.
  it("gates the STORED session name on user-set, while still showing the derived one", () => {
    const localEnv = ENVIRONMENTS.find((e) => e.id === "work-local");
    if (localEnv === undefined) throw new Error("fixture missing work-local");
    // Gated, not merely non-empty: this value is written into SessionLink.name by the MCP attach
    // (mcp/tools/task.ts), so a Claude auto-name landing here would be stored permanently.
    const blank = row({ statusline, statuslineStatus: "ok", claudeName: "auto-derived-title", claudeNameUserSet: false });
    const out = buildWhoami({
      resolution: { ok: true, env: localEnv, row: blank },
      envs: ENVIRONMENTS, snapshot: { ...snapshot, sessions: [blank, sibling] }, boards: [board],
    });
    if (!out.resolved) throw new Error("expected resolved");
    expect(out.session.sessionName).toBeNull();
    // The other half of the split, and the whole point of it: the session must still be TOLD the name
    // it answers to. Without this, re-gating the display field is invisible to the suite — and a
    // session that reads "name not captured" hands out its tab label, which for a resumed session is
    // the slugified card name and not an address (mcp/digest.ts).
    expect(out.session.claudeName).toBe("auto-derived-title");
    expect(out.task?.sessions.find((s) => s.name === "api-refactor-a")?.claudeName).toBe("auto-derived-title");
  });

  it("normalizes the name it hands out to be STORED, and drops one that normalizes away", () => {
    // This value reaches SessionLink.name through the MCP attach, whose body schema puts no bound on
    // it — so the normalizer here is the boundary, not a nicety.
    const localEnv = ENVIRONMENTS.find((e) => e.id === "work-local");
    if (localEnv === undefined) throw new Error("fixture missing work-local");
    const named = (claudeName: string): ReturnType<typeof buildWhoami> => {
      const r = row({ statusline, statuslineStatus: "ok", claudeName, claudeNameUserSet: true });
      return buildWhoami({
        resolution: { ok: true, env: localEnv, row: r },
        envs: ENVIRONMENTS, snapshot: { ...snapshot, sessions: [r, sibling] }, boards: [board],
      });
    };
    const trimmed = named("  auth-fix  ");
    if (!trimmed.resolved) throw new Error("expected resolved");
    expect(trimmed.session.sessionName).toBe("auth-fix");

    const blankAfterNormalize = named("   ");
    if (!blankAfterNormalize.resolved) throw new Error("expected resolved");
    expect(blankAfterNormalize.session.sessionName).toBeNull();
  });

  it("returns a null task for a session bound to nothing", () => {
    const localEnv = ENVIRONMENTS.find((e) => e.id === "work-local");
    if (localEnv === undefined) throw new Error("fixture missing work-local");
    const unbound = row({ paneId: "w7:p7", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
    const out = buildWhoami({
      resolution: { ok: true, env: localEnv, row: unbound }, envs: ENVIRONMENTS,
      snapshot: { ...snapshot, sessions: [...snapshot.sessions, unbound] }, boards: [board],
    });
    if (!out.resolved) throw new Error("expected resolved");
    expect(out.task).toBeNull();
  });

  it("treats a link whose pane was reused by a DIFFERENT session as detached", () => {
    // Link c points at w1:p9 with its own UUID; a stranger now holds that pane (herdr restart
    // recycled the id). The canonical resolver refuses the paneId fallback for a UUID-carrying
    // link, so the card must NOT report the stranger's status as ours.
    const stranger = row({ paneId: "w1:p9", sessionId: "cccccccc-dddd-4eee-8fff-000000000000", tab: "stranger" });
    const localEnv = ENVIRONMENTS.find((e) => e.id === "work-local");
    if (localEnv === undefined) throw new Error("fixture missing work-local");
    const out = buildWhoami({
      resolution: { ok: true, env: localEnv, row: me }, envs: ENVIRONMENTS,
      snapshot: { ...snapshot, sessions: [...snapshot.sessions, stranger] }, boards: [board],
    });
    if (!out.resolved) throw new Error("expected resolved");
    const c = (out.task?.sessions ?? []).find((s) => s.name === "api-refactor-c");
    expect(c?.detached).toBe(true);
    expect(c?.status).toBe("detached");
    expect(c?.ctxPct).toBeNull();
  });
});
