import type { SessionRow, StatuslineData } from "@shared/schema";
import type { WhoamiResponse } from "@shared/whoami-schema.ts";
import { describe, expect, it } from "vitest";

import type { CorralClient } from "../mcp/client.ts";
import { CorralError } from "../mcp/client.ts";
import type { Identity } from "../mcp/identity.ts";
import { createIdentity } from "../mcp/identity.ts";
import { fleetHandler } from "../mcp/tools/fleet.ts";
import { whoamiHandler } from "../mcp/tools/self.ts";
import { readHandler, TASK_TOOL_DESCRIPTIONS } from "../mcp/tools/task.ts";

const resolved: WhoamiResponse = {
  resolved: true,
  session: {
    env: "work-local", envLabel: "Work (local)", paneId: "w1:p1", tabId: "tab1",
    tabLabel: "alpha", workspaceId: "ws1", workspaceLabel: "repo",
    sessionId: "11111111-2222-3333-4444-555555555555", sessionName: "alpha", claudeName: null,
    cwd: "/repo", status: "working", model: "Opus",
    ctxPct: 41, costUsd: null, fiveHourPct: null, sevenDayPct: null, account: null, remoteControl: null,
  },
  task: null,
  envs: [{ id: "work-local", label: "Work (local)", kind: "local", reachable: true }],
};

function stub(over: Partial<CorralClient>): CorralClient {
  return {
    whoami: async () => resolved,
    attention: async () => ({}),
    board: async () => { throw new Error("unused"); },
    appendLog: async () => ({ ok: true, atMs: 1, logCount: 1 }),
    createTask: async () => ({ id: "t_new1234", title: "T", description: "", status: "todo", priority: null, sessions: [], createdAt: 1, updatedAt: 1 }),
    state: async () => ({ envs: {}, sessions: [] }),
    boards: async () => [],
    patchTask: async () => { throw new Error("unused"); },
    attach: async () => undefined,
    spawn: async () => ({ env: "work-local", paneId: "w1:p2", name: "n", workspaceLabel: "repo", cwdSnapshot: "/repo", idempotent: false }),
    closeSession: async () => undefined,
    spawnTargets: async () => [],
    ...over,
  };
}
const ctx = { paneId: "w1:p1", socket: null, cwd: "/repo" };

function fleetDeps(client: CorralClient): { client: CorralClient; identity: Identity } {
  return { client, identity: createIdentity(client, ctx) };
}

describe("whoamiHandler", () => {
  it("renders identity and tells an unbound session how to bind", async () => {
    const out = await whoamiHandler(createIdentity(stub({}), ctx));
    expect(out).toContain("w1:p1");
    expect(out).toContain("ctx: 41%");
    expect(out).toContain("corral_task_bind");
  });

  it("reports an unresolved identity as text rather than throwing", async () => {
    const client = stub({ whoami: async () => ({ resolved: false, reason: "no live session at pane w1:p1 in any local environment", envs: [] }) });
    const out = await whoamiHandler(createIdentity(client, ctx));
    expect(out).toContain("no live session");
  });

  it("reports an unreachable corral as text", async () => {
    const client = stub({ whoami: async () => { throw new CorralError("unreachable", "corral is not reachable"); } });
    expect(await whoamiHandler(createIdentity(client, ctx))).toContain("not reachable");
  });
});

// Pinned the way ORIENTATION is (test/mcp-orientation.test.ts): with corral_whoami no longer putting
// the description in front of a session, corral_task_update's own description is the LAST warning
// before a full-replacement write. Nothing else fails if a later token trim removes the pointer.
describe("task tool descriptions", () => {
  it("warns about the full-replacement write and names the read tool", () => {
    expect(TASK_TOOL_DESCRIPTIONS.update).toContain("FULL-REPLACEMENT");
    expect(TASK_TOOL_DESCRIPTIONS.update).toContain("corral_task_read");
  });

  // The contract itself, both halves, pinned on one distinctive token each rather than whole clauses:
  // a reword stays possible, a trim that drops what the field is FOR does not. The corrective half is
  // pinned separately because it is the one this string did not have before.
  it("states what the description is for", () => {
    expect(TASK_TOOL_DESCRIPTIONS.update).toContain("no durable carrier records");
    expect(TASK_TOOL_DESCRIPTIONS.update).toContain("committed to the repo");
    expect(TASK_TOOL_DESCRIPTIONS.update).toContain("Not a log of what you did");
  });

  // The split is only real if BOTH tool descriptions say the same thing about it. This one exists
  // because the update description used to claim decisions for `description`, which is precisely
  // what the log was added to hold — two steering surfaces disagreeing on the one rule that matters.
  it("sends what happened to the log rather than to the description", () => {
    expect(TASK_TOOL_DESCRIPTIONS.update).toContain("corral_task_log");
    expect(TASK_TOOL_DESCRIPTIONS.update).not.toContain("decisions and why");
    expect(TASK_TOOL_DESCRIPTIONS.log).toContain("APPEND-ONLY");
  });

  it("tells corral_task_read's caller that whoami only shows a preview", () => {
    expect(TASK_TOOL_DESCRIPTIONS.read).toContain("corral_whoami");
    expect(TASK_TOOL_DESCRIPTIONS.read.toLowerCase()).toContain("preview");
  });

  // The description is read at the exact moment the mistake is made: a session asked for "a new
  // session" reached for THIS tool, created a card nobody wanted, and staffed that instead of the
  // card it was already on. The refusal has to be in this string, not only in the skill.
  it("refuses to read a request for a session as a request for a card", () => {
    expect(TASK_TOOL_DESCRIPTIONS.create).toContain("corral_spawn");
    expect(TASK_TOOL_DESCRIPTIONS.create).toContain("start a new session");
    expect(TASK_TOOL_DESCRIPTIONS.create).toContain("the operator's call");
  });
});

describe("readHandler", () => {
  // A long log: this is exactly the shape corral_whoami now refuses to inline and corral_task_read
  // exists to return whole.
  const description = Array.from({ length: 200 }, (_, i) => `entry ${String(i)}`).join("\n");
  const boundTask = {
    boardId: "board", boardLabel: "Board", taskId: "t_abcdefg", title: "Refactor the API",
    description, status: "doing", priority: null,
    columns: [{ id: "todo", label: "Todo", closed: false }, { id: "doing", label: "Doing", closed: false }],
    sessions: [], logCount: 0, noteCount: 0, lastLogAtMs: null,
  };

  it("returns the bound card's full description, past whoami's preview budget", async () => {
    const client = stub({ whoami: async () => ({ ...resolved, task: boundTask }) });
    const out = await readHandler({ client, identity: createIdentity(client, ctx) });
    expect(out).toContain("card: board/t_abcdefg");
    expect(out).toContain("  | entry 0");
    expect(out).toContain("  | entry 199");
    expect(out).not.toContain("TRUNCATED");
    // The preview line and its pointer belong to whoami — this reply is the value itself.
    expect(out).not.toContain("PREVIEW");
  });

  it("refuses an unbound session with the standard bind instruction", async () => {
    const client = stub({});  // the shared fixture is unbound
    const out = await readHandler({ client, identity: createIdentity(client, ctx) });
    expect(out).toContain("corral_task_bind");
  });

  it("reports an unreachable corral as text", async () => {
    const client = stub({ whoami: async () => { throw new CorralError("unreachable", "corral is not reachable"); } });
    expect(await readHandler({ client, identity: createIdentity(client, ctx) })).toContain("not reachable");
  });
});

describe("fleetHandler", () => {
  it("defaults to all, applies the hard limit, and includes the untrusted-output note", async () => {
    const client = stub({
      state: async () => ({
        envs: { "work-local": { reachable: true } },
        sessions: Array.from({ length: 60 }, (_, i) => ({
          env: "work-local", paneId: `w1:p${String(i)}`, status: "idle", agent: "claude", cwd: "/r",
          tab: `s${String(i)}`, workspace: "w", sessionId: null,
          recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
        })),
      }),
    });
    const out = await fleetHandler(fleetDeps(client), {});
    expect(out).toContain("more matched but were not shown");
    expect(out.toLowerCase()).toContain("untrusted");
  });

  it("clamps limit to the hard maximum of 50", async () => {
    const client = stub({
      state: async () => ({
        envs: { "work-local": { reachable: true } },
        sessions: Array.from({ length: 60 }, (_, i) => ({
          env: "work-local", paneId: `w1:p${String(i)}`, status: "idle", agent: "claude", cwd: "/r",
          tab: `s${String(i)}`, workspace: "w", sessionId: null,
          recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
        })),
      }),
    });
    const out = await fleetHandler(fleetDeps(client), { limit: 9999 });
    expect(out).toContain("10 more matched"); // 60 sessions minus the 50 hard cap — proves the clamp
  });

  it("reports an unreachable corral as text", async () => {
    const client = stub({ state: async () => { throw new CorralError("unreachable", "corral is not reachable"); } });
    expect(await fleetHandler(fleetDeps(client), {})).toContain("not reachable");
  });

  // The wiring itself: this session's own account has to travel from the whoami read into the
  // rendered row. Asserting only the "no marker" case (below) would pass with the plumbing deleted.
  it("carries this session's own account into the digest, marking only the rows that differ", async () => {
    const statusline = (email: string): StatuslineData => ({
      v: 1, captured_at: 0, session_id: "s1",
      account: { uuid: null, email, org: null, tier: null },
      model: null, model_id: null,
      ctx: { pct: null, tokens: null, window: null },
      cost: { usd: null, lines_added: null, lines_removed: null },
      rate: { five_hour: null, seven_day: null },
      effort: null, thinking: null, cc_version: null,
    });
    const stateRow = (paneId: string, tab: string, email: string): SessionRow => ({
      env: "work-local", paneId, status: "idle", agent: "claude", cwd: "/r",
      tab, workspace: "w", sessionId: null,
      recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: statusline(email),
      statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
    });
    const client = stub({
      whoami: async () => ({ ...resolved, session: { ...resolved.session, account: "me@example.com" } }),
      state: async () => ({
        envs: { "work-local": { reachable: true } },
        sessions: [stateRow("w1:p1", "mine", "me@example.com"), stateRow("w1:p2", "theirs", "other@example.com")],
      }),
    });
    const out = await fleetHandler(fleetDeps(client), {});
    expect(out.split("\n").find((l) => l.includes("theirs"))).toContain("account: other@example.com");
    expect(out.split("\n").find((l) => l.includes("mine"))).not.toContain("account:");
  });

  // The account marker is an extra, not a precondition: a session whose own pane corral cannot
  // resolve still gets the digest. Before the catch, the identity read took the whole tool down —
  // a strictly worse answer than the same rows without one marker.
  it("still renders the digest when this session's own identity does not resolve", async () => {
    const client = stub({
      whoami: async () => ({ resolved: false, reason: "no live session at pane w1:p1", envs: [] }),
      state: async () => ({
        envs: { "work-local": { reachable: true } },
        sessions: [{
          env: "work-local", paneId: "w1:p1", status: "idle", agent: "claude", cwd: "/r",
          tab: "solo", workspace: "w", sessionId: null,
          recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null,
          statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
        }],
      }),
    });
    const out = await fleetHandler(fleetDeps(client), {});
    expect(out).toContain("solo");
    expect(out).not.toContain("account:");
  });
});

// Self-review coverage: the brief's given tests prove the max-50 clamp but don't pin down the
// three arg defaults individually or exercise every FLEET_FILTERS member — these tests close that gap.
describe("fleetHandler defaults and filters", () => {
  const mixed = {
    envs: { "work-local": { reachable: true } },
    sessions: [
      { env: "work-local", paneId: "w1:p1", status: "working", agent: "claude", cwd: "/r", tab: "s1", workspace: "w", sessionId: null, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null },
      { env: "work-local", paneId: "w1:p2", status: "idle", agent: "claude", cwd: "/r", tab: "s2", workspace: "w", sessionId: null, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null },
      { env: "work-local", paneId: "w1:p3", status: "blocked", agent: "claude", cwd: "/r", tab: "s3", workspace: "w", sessionId: null, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null },
      { env: "work-local", paneId: "w1:p4", status: "done", agent: "claude", cwd: "/r", tab: "s4", workspace: "w", sessionId: null, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null },
    ],
  };

  it("defaults filter to all — every status is included when the arg is omitted", async () => {
    const client = stub({ state: async () => mixed });
    const out = await fleetHandler(fleetDeps(client), {});
    expect(out).toContain("w1:p1");
    expect(out).toContain("w1:p2");
    expect(out).toContain("w1:p3");
    expect(out).toContain("w1:p4");
  });

  it("filter=working returns only the working session", async () => {
    const client = stub({ state: async () => mixed });
    const out = await fleetHandler(fleetDeps(client), { filter: "working" });
    expect(out).toContain("w1:p1");
    expect(out).not.toContain("w1:p2");
    expect(out).not.toContain("w1:p3");
    expect(out).not.toContain("w1:p4");
  });

  it("filter=idle returns idle and done sessions", async () => {
    const client = stub({ state: async () => mixed });
    const out = await fleetHandler(fleetDeps(client), { filter: "idle" });
    expect(out).not.toContain("w1:p1");
    expect(out).toContain("w1:p2");
    expect(out).not.toContain("w1:p3");
    expect(out).toContain("w1:p4");
  });

  it("filter=needs-attention returns blocked sessions and attention-map hits", async () => {
    const client = stub({
      state: async () => mixed,
      attention: async () => ({
        "work-local:w1:p4": { state: "finished", since: Date.now(), sessionName: "s4", claudeName: null, lastLines: "", captured: true },
      }),
    });
    const out = await fleetHandler(fleetDeps(client), { filter: "needs-attention" });
    expect(out).not.toContain("w1:p1");
    expect(out).not.toContain("w1:p2");
    expect(out).toContain("w1:p3"); // live blocked
    expect(out).toContain("w1:p4"); // attention-map "finished" record
  });

  it("defaults limit to 20 — dropping exactly the remainder of a 25-session match", async () => {
    const client = stub({
      state: async () => ({
        envs: { "work-local": { reachable: true } },
        sessions: Array.from({ length: 25 }, (_, i) => ({
          env: "work-local", paneId: `w1:p${String(i)}`, status: "idle", agent: "claude", cwd: "/r",
          tab: `s${String(i)}`, workspace: "w", sessionId: null,
          recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
        })),
      }),
    });
    const out = await fleetHandler(fleetDeps(client), {});
    expect(out).toContain("5 more matched"); // 25 sessions minus the default limit of 20
  });

  it("defaults recapChars to 160 — a longer recap is truncated at that length", async () => {
    const longRecap = "x".repeat(200);
    const client = stub({
      state: async () => ({
        envs: { "work-local": { reachable: true } },
        sessions: [{
          env: "work-local", paneId: "w1:p1", status: "idle", agent: "claude", cwd: "/r",
          tab: "s1", workspace: "w", sessionId: null,
          recap: longRecap, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
        }],
      }),
    });
    const out = await fleetHandler(fleetDeps(client), {});
    expect(out).toContain(`"${"x".repeat(160)}…"`);
    expect(out).not.toContain("x".repeat(161));
  });
});
