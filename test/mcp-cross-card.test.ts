import type { Board } from "@shared/board-schema.ts";
import { LOG_ENTRY_TEXT_MAX } from "@shared/board-schema.ts";
import type { WhoamiResponse, WhoamiTask } from "@shared/whoami-schema.ts";
import { describe, expect, it, vi } from "vitest";

import type { CorralClient } from "../mcp/client.ts";
import { createIdentity } from "../mcp/identity.ts";
import { closeHandler, spawnHandler } from "../mcp/tools/session.ts";
import { boardReadHandler, createHandler, logHandler, readHandler } from "../mcp/tools/task.ts";

const SID = "11111111-2222-3333-4444-555555555555";

const boundTask: WhoamiTask = {
  boardId: "board", boardLabel: "Board", taskId: "t_abcdefg", title: "Own card", description: "own desc",
  status: "doing", priority: null,
  columns: [{ id: "todo", label: "Todo", closed: false }, { id: "doing", label: "Doing", closed: false }],
  sessions: [], logCount: 0, lastLogAtMs: null,
};
const bound: WhoamiResponse = {
  resolved: true,
  session: {
    env: "work-local", envLabel: "Work (local)", paneId: "w1:p1", tabId: "tab1",
    tabLabel: "alpha", workspaceId: "ws1", workspaceLabel: "repo",
    sessionId: SID, sessionName: "alpha", claudeName: null, cwd: "/repo", status: "working", model: "Opus",
    ctxPct: 41, costUsd: null, fiveHourPct: null, sevenDayPct: null, account: null, remoteControl: null,
  },
  task: boundTask,
  envs: [{ id: "work-local", label: "Work (local)", kind: "local", reachable: true }],
};

// Two boards: the caller's own, and another carrying a card with a log and a card in a CLOSED column.
const otherBoard: Board = {
  id: "other", label: "Other",
  columns: [{ id: "todo", label: "Todo" }, { id: "done", label: "Done", type: "closed" }],
  tasks: [
    { id: "t_other11", title: "Their card", description: "their desc", status: "todo", priority: "p2", sessions: [],
      createdAt: 1, updatedAt: 2, log: [{ id: "e1", atMs: 1000, source: { sessionId: null, name: "them" }, kind: "note", text: "their note" }] },
    { id: "t_closed1", title: "Closed card", description: "", status: "done", priority: null, sessions: [{
      env: "work-local", paneId: "w2:p1", tabId: "tb", tabLabel: "x", workspaceId: "ws", workspaceLabel: "w",
      name: "ghost", cwdSnapshot: "/x", sessionId: null }], createdAt: 1, updatedAt: 2, log: [] },
  ],
  spawnPresets: [], defaultSpawnPresetId: null,
};
const ownBoard: Board = {
  id: "board", label: "Board", columns: boundTask.columns.map((c) => ({ id: c.id, label: c.label })),
  tasks: [{ id: "t_abcdefg", title: "Own card", description: "own desc", status: "doing", priority: null, sessions: [], createdAt: 1, updatedAt: 2, log: [] }],
  spawnPresets: [], defaultSpawnPresetId: null,
};

function stub(over: Partial<CorralClient>): CorralClient {
  return {
    whoami: async () => bound,
    attention: async () => ({}),
    board: async (id) => (id === "other" ? otherBoard : ownBoard),
    appendLog: async () => ({ ok: true, atMs: 1, logCount: 1 }),
    createTask: async () => ({ id: "t_new1234", title: "New", description: "", status: "todo", priority: null, sessions: [], createdAt: 1, updatedAt: 1 }),
    state: async () => ({ envs: {}, sessions: [] }),
    boards: async () => [ownBoard, otherBoard],
    patchTask: async () => { throw new Error("unused"); },
    attach: async () => undefined,
    spawn: async () => ({ env: "work-local", paneId: "w1:p2", name: "n", workspaceLabel: "repo", cwdSnapshot: "/repo", idempotent: false }),
    closeSession: async () => undefined,
    spawnTargets: async () => ["corral", "demo-api"],
    ...over,
  };
}
const ctx = { paneId: "w1:p1", socket: null, cwd: "/repo" };
const deps = (c: CorralClient) => ({ client: c, identity: createIdentity(c, ctx) });

// Fresh spies (not method references off a stub — that trips no-unbound-method), each returning the
// same value the default stub would, so a test can assert how it was called.
const boardSpy = () => vi.fn(async (id: string) => (id === "other" ? otherBoard : ownBoard));
const appendLogSpy = () => vi.fn(async () => ({ ok: true, atMs: 1, logCount: 1 }));
const createTaskSpy = () => vi.fn(async () => ({ id: "t_new1234", title: "New", description: "", status: "todo", priority: null, sessions: [], createdAt: 1, updatedAt: 1 }));
const spawnSpy = () => vi.fn(async () => ({ env: "work-local", paneId: "w1:p2", name: "n", workspaceLabel: "repo", cwdSnapshot: "/repo", idempotent: false }));

describe("addressing — a bare taskId is refused, a valid pair is honoured, a wrong board is not resolved", () => {
  it("read: refuses a taskId without a boardId, and issues no board read", async () => {
    const board = boardSpy();
    const out = await readHandler(deps(stub({ board })), { taskId: "t_other11" });
    expect(out).toContain("boardId is required");
    expect(board).not.toHaveBeenCalled();
  });

  it("read: a {boardId, taskId} naming a task on the WRONG board is refused, not silently resolved", async () => {
    // t_other11 lives on "other", not on "board" — the pair must be validated against the listing.
    const out = await readHandler(deps(stub({})), { boardId: "board", taskId: "t_other11" });
    expect(out).toContain("no card board/t_other11");
  });

  it("read: renders another card's description and log for a valid pair", async () => {
    const out = await readHandler(deps(stub({})), { boardId: "other", taskId: "t_other11" });
    expect(out).toContain("card: other/t_other11");
    expect(out).toContain("their desc");
    expect(out).toContain("their note");
  });

  it("log: refuses a bare taskId and never calls appendLog", async () => {
    const appendLog = appendLogSpy();
    const out = await logHandler(deps(stub({ appendLog })), { text: "x", taskId: "t_other11" });
    expect(out).toContain("boardId is required");
    expect(appendLog).not.toHaveBeenCalled();
  });

  it("log: appends to another card with the CALLER's own env/paneId, not the target's", async () => {
    const appendLog = appendLogSpy();
    const out = await logHandler(deps(stub({ appendLog })), { text: "note", boardId: "other", taskId: "t_other11" });
    // The title comes from the TARGET card, not the caller's: an id alone names nothing, and naming
    // the wrong card would be worse than naming none.
    expect(out).toContain('logged to other/t_other11 ("Their card")');
    expect(appendLog).toHaveBeenCalledWith(expect.objectContaining({ boardId: "other", taskId: "t_other11", env: "work-local", paneId: "w1:p1", text: "note" }));
  });

  it("log: refuses a note over the cap in its own words, with the overage, before any network call", async () => {
    const appendLog = appendLogSpy();
    const out = await logHandler(deps(stub({ appendLog })), { text: "x".repeat(LOG_ENTRY_TEXT_MAX + 12) });
    expect(out).toContain("12 characters over");
    expect(out).toContain("nothing was written");
    expect(appendLog).not.toHaveBeenCalled();
  });

  it("log: a stored entry that ran long is accepted, and the reply says so — a short one gets no nudge", async () => {
    const long = await logHandler(deps(stub({})), { text: "x".repeat(LOG_ENTRY_TEXT_MAX / 2 + 1) });
    expect(long).toContain("logged to");
    expect(long).toContain("ran long");
    const short = await logHandler(deps(stub({})), { text: "decided X over Y: Z." });
    expect(short).toContain("logged to");
    expect(short).not.toContain("ran long");
  });

  it("log: surrounding whitespace does not count against the cap", async () => {
    const appendLog = appendLogSpy();
    const out = await logHandler(deps(stub({ appendLog })), { text: `  ${"x".repeat(LOG_ENTRY_TEXT_MAX)}  ` });
    expect(out).toContain("logged to");
    expect(appendLog).toHaveBeenCalledTimes(1);
  });
});

describe("corral_board_read — shows closed-column cards that the bind picker hides", () => {
  it("lists every card and marks the one in a closed column", async () => {
    const out = await boardReadHandler(deps(stub({})), { boardId: "other" });
    expect(out).toContain("other/t_other11");
    expect(out).toContain("other/t_closed1");
    expect(out).toContain("[closed]");
  });
});

describe("corral_task_create — creates without spawning, provenance carried to the route", () => {
  it("calls createTask (never spawn) with the creator's coordinates and the follow-up card", async () => {
    const createTask = createTaskSpy();
    const spawn = spawnSpy();
    const out = await createHandler(deps(stub({ createTask, spawn })), { title: "A new task" });
    expect(spawn).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      boardId: "board", title: "A new task", env: "work-local", paneId: "w1:p1",
      sourceBoardId: "board", sourceTaskId: "t_abcdefg",
    }));
    expect(out).toContain("has no session");
  });
});

describe("corral_spawn — targeting another card requires a repo", () => {
  it("refuses a cross-card spawn with no repo and lists the target env's repositories", async () => {
    const spawn = spawnSpy();
    const out = await spawnHandler(deps(stub({ spawn })), { brief: "go", boardId: "other", taskId: "t_other11" });
    expect(spawn).not.toHaveBeenCalled();
    expect(out).toContain("corral");
    expect(out).toContain("demo-api");
  });

  it("spawns onto the named card when a repo is given", async () => {
    const spawn = spawnSpy();
    await spawnHandler(deps(stub({ spawn })), { brief: "go", boardId: "other", taskId: "t_other11", repo: "corral" });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ boardId: "other", taskId: "t_other11", repo: "corral" }));
  });

  // Both titles are in scope where the reply is built — the caller's own card and the target's — and
  // they are both plain strings, so swapping them compiles and says the wrong card was staffed.
  it("spawn: the reply names the TARGET card, never the caller's own", async () => {
    const out = await spawnHandler(deps(stub({ spawn: spawnSpy() })), { brief: "go", boardId: "other", taskId: "t_other11", repo: "corral" });
    expect(out).toContain('other/t_other11 ("Their card")');
    expect(out).not.toContain("Own card");
  });

  it("spawn: with no target, the reply names this session's own card", async () => {
    const out = await spawnHandler(deps(stub({ spawn: spawnSpy() })), { brief: "go" });
    expect(out).toContain('board/t_abcdefg ("Own card")');
  });

  it("refuses a bare taskId without a boardId, and never spawns", async () => {
    const spawn = spawnSpy();
    const out = await spawnHandler(deps(stub({ spawn })), { brief: "go", taskId: "t_other11" });
    expect(spawn).not.toHaveBeenCalled();
    expect(out).toContain("must be given together");
  });
});

describe("the invariant — staffing another card grants no right to close its sessions", () => {
  it("refuses to close a session that is not on THIS session's card", async () => {
    // The post-cross-card-spawn state: the spawned session lives on the OTHER card, so it is absent
    // from this session's card list and close must refuse it.
    const withSibling: WhoamiResponse = {
      ...bound,
      task: { ...boundTask, sessions: [{ name: "self", claudeName: null, key: "work-local:w1:p1", sessionId: SID, status: "working", detached: false, ctxPct: null, self: true }] },
    };
    const out = await closeHandler(deps(stub({ whoami: async () => withSibling })), { target: "work-local:w2:p1" });
    expect(out).toContain("not attached to this session's card");
  });
});
