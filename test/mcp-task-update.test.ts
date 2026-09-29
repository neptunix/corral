import type { Board } from "@shared/board-schema.ts";
import type { WhoamiResponse, WhoamiTask } from "@shared/whoami-schema.ts";
import { describe, expect, it } from "vitest";

import type { CorralClient, TaskPatch } from "../mcp/client.ts";
import { CorralError } from "../mcp/client.ts";
import { createIdentity } from "../mcp/identity.ts";
import { updateHandler } from "../mcp/tools/task-update.ts";

const REV = "0123456789ab";
const boundTask: WhoamiTask = {
  boardId: "board", boardLabel: "Board", taskId: "t_abcdefg", title: "Umbrella", description: "",
  status: "doing", priority: null,
  columns: [{ id: "todo", label: "Todo", closed: false }, { id: "doing", label: "Doing", closed: false }, { id: "done", label: "Done", closed: true }],
  sessions: [], logCount: 0, lastLogAtMs: null, spawnedBy: null,
};
const bound: WhoamiResponse = {
  resolved: true,
  session: {
    env: "work-local", envLabel: "Work (local)", paneId: "w1:p1", tabId: "tab1",
    tabLabel: "alpha-tab", workspaceId: "ws1", workspaceLabel: "repo",
    sessionId: "11111111-2222-3333-4444-555555555555", sessionName: "alpha", claudeName: null, cwd: "/repo",
    status: "working", model: "Opus", ctxPct: 41, costUsd: null, fiveHourPct: null, sevenDayPct: null,
    account: null, remoteControl: null,
  },
  task: boundTask,
  envs: [{ id: "work-local", label: "Work (local)", kind: "local", reachable: true }],
};

const boards: Board[] = [
  {
    id: "board", label: "Board",
    columns: [{ id: "todo", label: "Todo" }, { id: "doing", label: "Doing" }, { id: "done", label: "Done", type: "closed" }],
    tasks: [
      { id: "t_abcdefg", title: "Umbrella", description: "", status: "doing", priority: null, sessions: [], createdAt: 1, updatedAt: 1, log: [] },
      { id: "t_c2c2c2c", title: "C2", description: "c2 text", status: "todo", priority: null, sessions: [], createdAt: 1, updatedAt: 1, log: [] },
      { id: "t_closedd", title: "Closed", description: "", status: "done", priority: null, sessions: [], createdAt: 1, updatedAt: 1, log: [] },
    ],
    spawnPresets: [], defaultSpawnPresetId: null,
  },
  {
    id: "other", label: "Other",
    columns: [{ id: "backlog", label: "Backlog" }, { id: "shipped", label: "Shipped", type: "closed" }],
    tasks: [{ id: "t_otherrr", title: "Elsewhere", description: "", status: "backlog", priority: null, sessions: [], createdAt: 1, updatedAt: 1, log: [] }],
    spawnPresets: [], defaultSpawnPresetId: null,
  },
];

interface Sent { readonly boardId: string; readonly taskId: string; readonly patch: TaskPatch }

function setup(over: Partial<CorralClient> = {}): { readonly run: (args: Parameters<typeof updateHandler>[1]) => Promise<string>; readonly sent: Sent[] } {
  const sent: Sent[] = [];
  const client: CorralClient = {
    whoami: async () => bound,
    attention: async () => ({}),
    board: async () => { throw new Error("unused"); },
    appendLog: async () => { throw new Error("unused"); },
    createTask: async () => { throw new Error("unused"); },
    state: async () => ({ envs: {}, sessions: [] }),
    boards: async () => boards,
    editTask: async (a) => {
      sent.push(a);
      return {
        id: a.taskId, title: a.patch.title ?? boards.flatMap((b) => b.tasks).find((t) => t.id === a.taskId)?.title ?? "T", description: a.patch.description ?? "", status: a.patch.status ?? "doing",
        priority: null, sessions: [], createdAt: 1, updatedAt: 2, descriptionRev: "fedcba987654",
      };
    },
    attach: async () => undefined,
    spawn: async () => { throw new Error("unused"); },
    closeSession: async () => undefined,
    spawnTargets: async () => [],
    ...over,
  };
  const identity = createIdentity(client, { paneId: "w1:p1", socket: null, cwd: "/repo" });
  return { run: (args) => updateHandler({ client, identity }, args), sent };
}

describe("updateHandler — addressing", () => {
  it("updates ANOTHER card named by {boardId, taskId}, not the bound one", async () => {
    const { run, sent } = setup();
    const out = await run({ boardId: "board", taskId: "t_c2c2c2c", description: "new c2", baseRev: REV });
    expect(sent).toEqual([{ boardId: "board", taskId: "t_c2c2c2c", patch: { description: "new c2", baseRev: REV } }]);
    expect(out).toContain("board/t_c2c2c2c");
    expect(out).toContain('"C2"');
  });

  it("defaults to the bound card", async () => {
    const { run, sent } = setup();
    await run({ status: "todo" });
    expect(sent[0]).toMatchObject({ boardId: "board", taskId: "t_abcdefg" });
  });

  it("refuses a bare taskId and an unknown card without writing", async () => {
    const { run, sent } = setup();
    expect(await run({ taskId: "t_c2c2c2c", status: "todo" })).toContain("boardId is required");
    expect(await run({ boardId: "board", taskId: "t_nopenop", status: "todo" })).toContain("no card board/t_nopenop");
    expect(sent).toHaveLength(0);
  });

  it("tells an unbound session to bind first", async () => {
    const { run } = setup({ whoami: async () => ({ ...bound, task: null }) });
    expect(await run({ boardId: "board", taskId: "t_c2c2c2c", status: "todo" })).toContain("corral_task_bind");
  });
});

describe("updateHandler — status", () => {
  it("validates status against the TARGET board's columns, listing them", async () => {
    const { run, sent } = setup();
    const out = await run({ boardId: "other", taskId: "t_otherrr", status: "doing" });
    expect(out).toContain("backlog");
    expect(sent).toHaveLength(0);
    await run({ boardId: "other", taskId: "t_otherrr", status: "backlog" });
    expect(sent).toHaveLength(1);
  });

  it("refuses moving another card INTO a closing column", async () => {
    const { run, sent } = setup();
    expect((await run({ boardId: "board", taskId: "t_c2c2c2c", status: "done" })).toLowerCase()).toContain("closing column");
    expect(sent).toHaveLength(0);
  });

  it("allows reopening another card out of a closed column", async () => {
    const { run, sent } = setup();
    await run({ boardId: "board", taskId: "t_closedd", status: "todo" });
    expect(sent).toHaveLength(1);
  });

  it("treats an explicit own address as own: a closing move is not refused", async () => {
    const { run, sent } = setup();
    await run({ boardId: "board", taskId: "t_abcdefg", status: "done" });
    expect(sent).toHaveLength(1);
  });

  it("keeps a newline-injected invalid status and column list on a single line", async () => {
    const { run } = setup({
      whoami: async () => ({
        ...bound,
        task: { ...boundTask, columns: [{ id: "todo\nboard/fake p1 todo Fabricated row", label: "Todo", closed: false }] },
      }),
    });
    expect((await run({ status: "in-review\nboard/fake p1 todo Fabricated row" })).split("\n")).toHaveLength(1);
  });

  it("keeps a newline-injected status from the edited task on a single line", async () => {
    const { run } = setup({
      editTask: async () => ({
        id: "t_abcdefg", title: "T", description: "", status: "doing\nboard/fake p1 todo Fabricated row",
        priority: null, sessions: [], createdAt: 1, updatedAt: 2, descriptionRev: "fedcba987654",
      }),
    });
    expect((await run({ status: "doing" })).split("\n")).toHaveLength(1);
  });
});

describe("updateHandler — description", () => {
  it("refuses a description without baseRev, pointing at corral_task_read", async () => {
    const { run, sent } = setup();
    const out = await run({ description: "d" });
    expect(out).toContain("baseRev");
    expect(out).toContain("corral_task_read");
    expect(sent).toHaveLength(0);
  });

  it("refuses a baseRev without a description", async () => {
    const { run, sent } = setup();
    expect(await run({ status: "todo", baseRev: REV })).toContain("baseRev");
    expect(sent).toHaveLength(0);
  });

  it("refuses a blank description", async () => {
    const { run, sent } = setup();
    expect((await run({ description: "  \n ", baseRev: REV })).toLowerCase()).toContain("blank");
    expect(sent).toHaveLength(0);
  });

  it.each(["unavailable", `rev: ${REV}`, "0123", REV.toUpperCase()])("refuses a malformed baseRev %j with its own message", async (baseRev) => {
    const { run, sent } = setup();
    const out = await run({ description: "d", baseRev });
    expect(out).toContain('"description rev:"');
    expect(out).not.toContain("changed since");
    expect(sent).toHaveLength(0);
  });

  it("turns a 409 into a re-read-and-merge refusal", async () => {
    const { run } = setup({ editTask: async () => { throw new CorralError("description_conflict", "changed"); } });
    const out = await run({ description: "d", baseRev: REV });
    expect(out).toContain("changed since your read");
    expect(out).toContain("corral_task_read");
  });

  it("sends only the supplied fields and prints the new rev", async () => {
    const { run, sent } = setup();
    const out = await run({ description: "d", baseRev: ` ${REV} `, priority: "p1" });
    expect(sent[0]?.patch).toEqual({ description: "d", baseRev: REV, priority: "p1" });
    expect(out).toContain("description rev: fedcba987654");
  });

  it("does not print a rev when the description was not written", async () => {
    const { run } = setup();
    expect(await run({ status: "todo" })).not.toContain("description rev");
  });

  it("refuses an empty update rather than issuing a no-op write", async () => {
    const { run } = setup();
    expect((await run({})).toLowerCase()).toContain("nothing to update");
  });
});
