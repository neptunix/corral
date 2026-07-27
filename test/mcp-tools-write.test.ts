import type { Board } from "@shared/board-schema.ts";
import type { WhoamiResponse, WhoamiTask } from "@shared/whoami-schema.ts";
import { describe, expect, it } from "vitest";

import type { CorralClient, TaskPatch } from "../mcp/client.ts";
import { CorralError } from "../mcp/client.ts";
import { createIdentity } from "../mcp/identity.ts";
import { closeHandler, spawnHandler } from "../mcp/tools/session.ts";
import { bindHandler, updateHandler } from "../mcp/tools/task.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const SID_B = "99999999-8888-7777-6666-555555555555";
const boundTask: WhoamiTask = {
  boardId: "board", boardLabel: "Board", taskId: "t_abcdefg", title: "T", description: "",
  status: "doing", priority: null,
  columns: [{ id: "todo", label: "Todo" }, { id: "doing", label: "Doing" }],
  sessions: [],
};
const bound: WhoamiResponse = {
  resolved: true,
  session: {
    env: "work-local", envLabel: "Work (local)", paneId: "w1:p1", tabId: "tab1",
    tabLabel: "alpha", workspaceId: "ws1", workspaceLabel: "repo",
    sessionId: SID, sessionName: "alpha", cwd: "/repo", status: "working", model: "Opus",
    ctxPct: 41, costUsd: null, fiveHourPct: null, sevenDayPct: null, account: null,
  },
  task: boundTask,
  envs: [{ id: "work-local", label: "Work (local)", kind: "local", reachable: true }],
};
const unbound: WhoamiResponse = { ...bound, task: null };

const boards: Board[] = [{
  id: "board", label: "Board",
  columns: [{ id: "todo", label: "Todo" }, { id: "done", label: "Done", type: "closed" }],
  tasks: [{ id: "t_aaaaaaa", title: "Open one", description: "", status: "todo", priority: "p1", repo: null, sessions: [], createdAt: 1, updatedAt: 1 }],
}];

function stub(over: Partial<CorralClient>): CorralClient {
  return {
    whoami: async () => bound,
    attention: async () => ({}),
    state: async () => ({ envs: {}, sessions: [] }),
    boards: async () => boards,
    patchTask: async () => ({ id: "t_abcdefg", title: "T", description: "", status: "doing", priority: null, repo: null, sessions: [], createdAt: 1, updatedAt: 2 }),
    attach: async () => undefined,
    spawn: async () => ({ env: "work-local", paneId: "w1:p2", name: "t-b" }),
    closeSession: async () => undefined,
    ...over,
  };
}
const ctx = { paneId: "w1:p1", socket: null, cwd: "/repo" };
const idOf = (c: CorralClient) => createIdentity(c, ctx);

describe("bindHandler", () => {
  it("lists open cards when called with no arguments", async () => {
    const c = stub({ whoami: async () => unbound });
    const out = await bindHandler({ client: c, identity: idOf(c) }, {});
    expect(out).toContain("t_aaaaaaa");
  });

  it("refuses to rebind an already-bound session and names the current card", async () => {
    const c = stub({});
    const out = await bindHandler({ client: c, identity: idOf(c) }, { boardId: "board", taskId: "t_aaaaaaa" });
    expect(out).toContain("t_abcdefg");
    expect(out.toLowerCase()).toContain("already");
  });

  it("attaches with both ids present", async () => {
    const calls: unknown[] = [];
    const c = stub({ whoami: async () => unbound, attach: async (a) => { calls.push(a); } });
    const out = await bindHandler({ client: c, identity: idOf(c) }, { boardId: "board", taskId: "t_aaaaaaa" });
    expect(calls).toHaveLength(1);
    expect(out.toLowerCase()).toContain("bound");
  });

  it("asks for the missing id when only one is given", async () => {
    const c = stub({ whoami: async () => unbound });
    const out = await bindHandler({ client: c, identity: idOf(c) }, { taskId: "t_aaaaaaa" });
    expect(out.toLowerCase()).toContain("boardid");
  });

  it("refuses to attach a taskId that does not match any open card, and never reaches attach", async () => {
    // A "/" and "?" carrying taskId is exactly the shape that, unencoded, could splice a different
    // route into the request (mcp/client.ts's `seg`) — this proves it's refused up front by
    // existence check, regardless of what the client-level encoding does.
    const calls: unknown[] = [];
    const evilTaskId = "t_aaaaaaa/sessions/work-local/w1:p9/close?x=";
    const c = stub({ whoami: async () => unbound, attach: async (a) => { calls.push(a); } });
    const out = await bindHandler({ client: c, identity: idOf(c) }, { boardId: "board", taskId: evilTaskId });
    expect(calls).toHaveLength(0);
    expect(out.toLowerCase()).toContain("no open card");
  });
});

describe("updateHandler", () => {
  it("rejects a status that is not one of the board's column ids, listing the valid ones", async () => {
    const c = stub({});
    const out = await updateHandler({ client: c, identity: idOf(c) }, { status: "in-review" });
    expect(out).toContain("todo");
    expect(out).toContain("doing");
  });

  it("sends only the supplied fields", async () => {
    const seen: TaskPatch[] = [];
    const c = stub({ patchTask: async (a) => { seen.push(a.patch); return { id: "t_abcdefg", title: "T", description: "d", status: "doing", priority: "p1", repo: null, sessions: [], createdAt: 1, updatedAt: 2 }; } });
    await updateHandler({ client: c, identity: idOf(c) }, { description: "d", priority: "p1" });
    expect(seen[0]).toEqual({ description: "d", priority: "p1" });
  });

  it("refuses an empty update rather than issuing a no-op write", async () => {
    const c = stub({});
    expect((await updateHandler({ client: c, identity: idOf(c) }, {})).toLowerCase()).toContain("nothing to update");
  });

  it("tells an unbound session to bind first", async () => {
    const c = stub({ whoami: async () => unbound });
    expect(await updateHandler({ client: c, identity: idOf(c) }, { status: "doing" })).toContain("corral_task_bind");
  });
});

describe("spawnHandler", () => {
  it("spawns on the caller's own card and returns the new session's target key", async () => {
    const c = stub({});
    const out = await spawnHandler({ client: c, identity: idOf(c) }, { brief: "continue" });
    expect(out).toContain("work-local:w1:p2");
  });

  it("defaults to the caller's environment and honours an override", async () => {
    const seen: string[] = [];
    const c = stub({ spawn: async (a) => { seen.push(a.env); return { env: a.env, paneId: "w1:p2", name: "t-b" }; } });
    await spawnHandler({ client: c, identity: idOf(c) }, { brief: "b" });
    await spawnHandler({ client: c, identity: idOf(c) }, { brief: "b", env: "personal-local" });
    expect(seen).toEqual(["work-local", "personal-local"]);
  });

  it("joins the caller's workspace same-env and creates fresh cross-env", async () => {
    const seen: (string | undefined)[] = [];
    const c = stub({ spawn: async (a) => { seen.push(a.targetWorkspaceId); return { env: a.env, paneId: "w1:p2", name: "t-b" }; } });
    await spawnHandler({ client: c, identity: idOf(c) }, { brief: "b" });
    await spawnHandler({ client: c, identity: idOf(c) }, { brief: "b", env: "personal-local" });
    expect(seen).toEqual(["ws1", undefined]);
  });

  it("requires a brief", async () => {
    const c = stub({});
    expect((await spawnHandler({ client: c, identity: idOf(c) }, { brief: "  " })).toLowerCase())
      .toContain("brief");
  });

  it("surfaces the server's repo-configuration error verbatim", async () => {
    const c = stub({ spawn: async () => { throw new CorralError("spawn_error", 'no path configured for repo "repo" in env personal-local'); } });
    const out = await spawnHandler({ client: c, identity: idOf(c) }, { brief: "b", env: "personal-local" });
    expect(out).toContain("no path configured for repo");
  });
});

describe("closeHandler", () => {
  it("closes self by default, deferring the pane kill past the response", async () => {
    const calls: { env: string; paneId: string; deferred: boolean | undefined }[] = [];
    const c = stub({ closeSession: async (a) => { calls.push({ env: a.env, paneId: a.paneId, deferred: a.deferred }); } });
    const out = await closeHandler({ client: c, identity: idOf(c) }, {});
    expect(calls).toEqual([{ env: "work-local", paneId: "w1:p1", deferred: true }]);
    expect(out.toLowerCase()).toContain("resume");
  });

  it("closes a sibling attached to the same card", async () => {
    const calls: string[] = [];
    const c = stub({
      whoami: async () => ({
        ...bound,
        task: {
          ...boundTask,
          sessions: [{ name: "t-b", key: "work-local:w1:p2", sessionId: null, status: "idle", detached: false, ctxPct: null, self: false }],
        },
      }),
      closeSession: async (a) => { calls.push(`${a.env}:${a.paneId}`); },
    });
    const out = await closeHandler({ client: c, identity: idOf(c) }, { target: "work-local:w1:p2" });
    expect(calls).toEqual(["work-local:w1:p2"]);
    expect(out.toLowerCase()).not.toContain("refus");
  });

  it("passes the sibling's UUID from the card list as sid", async () => {
    const sids: (string | null)[] = [];
    const c = stub({
      whoami: async () => ({
        ...bound,
        task: {
          ...boundTask,
          sessions: [{ name: "t-b", key: "work-local:w1:p2", sessionId: SID_B, status: "working", detached: false, ctxPct: 10, self: false }],
        },
      }),
      closeSession: async (a) => { sids.push(a.sessionId); },
    });
    await closeHandler({ client: c, identity: idOf(c) }, { target: "work-local:w1:p2" });
    expect(sids).toEqual([SID_B]); // unknown at spawn time, known by close time — the card list carries it
  });

  it("refuses a target that is not attached to this session's card", async () => {
    // The bound fixture's card list is empty, so any non-self target is off-card.
    const calls: string[] = [];
    const c = stub({ closeSession: async (a) => { calls.push(a.paneId); } });
    const out = await closeHandler({ client: c, identity: idOf(c) }, { target: "work-local:w9:p9" });
    expect(calls).toHaveLength(0);
    expect(out.toLowerCase()).toContain("refus");
    expect(out).toContain("card");
  });

  it("refuses a target absent from a NON-EMPTY card session list", async () => {
    // Distinct from the test above: the card list here is non-empty (one real sibling), so this
    // kills a mutant that approximates membership as "the card has any sessions at all" instead of
    // actually matching the target key against the list.
    const calls: string[] = [];
    const c = stub({
      whoami: async () => ({
        ...bound,
        task: {
          ...boundTask,
          sessions: [{ name: "t-b", key: "work-local:w1:p2", sessionId: null, status: "idle", detached: false, ctxPct: null, self: false }],
        },
      }),
      closeSession: async (a) => { calls.push(a.paneId); },
    });
    const out = await closeHandler({ client: c, identity: idOf(c) }, { target: "work-local:w9:p9" });
    expect(calls).toHaveLength(0);
    expect(out.toLowerCase()).toContain("refus");
    expect(out).toContain("card");
  });

  it("rejects a malformed target", async () => {
    const c = stub({});
    expect((await closeHandler({ client: c, identity: idOf(c) }, { target: "nonsense" })).toLowerCase())
      .toContain("env:paneid");
  });
});
