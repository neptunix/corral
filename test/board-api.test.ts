import { DEFAULT_COLUMNS } from "@shared/board-schema";
import type { SessionRow, Snapshot } from "@shared/schema";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { TASK_DESCRIPTION_MAX_CHARS } from "../config.ts";
import { ENVIRONMENTS } from "../environments.ts";
import { createApi } from "../server/api.ts";
import type { Poller } from "../server/poller.ts";
import { NAME_MAX, type SpawnResult } from "../server/spawn.ts";
import { createStorage } from "../server/storage.ts";

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "api-test-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

const snap: Snapshot = {
  envs: { "work-local": { reachable: true } },
  sessions: [],
};
const poller: Poller = {
  getSnapshot: () => snap,
  getAttention: () => ({}),
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  onSnapshot: () => () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  pollOnce: async () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  refreshEnv: async () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  runClaudeSweepOnce: async () => {},
  applyRegistry: () => undefined,
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  start: () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  stop: () => {},
};

function makeApi(dataDir: string) {
  return createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(dataDir) });
}

describe("POST /api/boards", () => {
  it("creates a board and returns it", async () => {
    const app = makeApi(tmpDir);
    const res = await app.request("/api/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Work" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; label: string };
    expect(body.id).toBe("work");
    expect(body.label).toBe("Work");
  });

  it("returns 409 on duplicate id", async () => {
    const app = makeApi(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Work" }) });
    const res = await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Work" }) });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string; generatedId: string } };
    expect(body.error.code).toBe("board_id_collision");
    expect(body.error.generatedId).toBe("work");
  });
});

describe("GET /api/boards", () => {
  it("lists all boards", async () => {
    const app = makeApi(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "A" }) });
    const res = await app.request("/api/boards");
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toHaveLength(1);
  });
});

describe("PATCH /api/boards/:bid — column type", () => {
  it("persists a column's type and rejects an invalid enum value", async () => {
    const app = makeApi(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Types" }) });
    const patchRes = await app.request("/api/boards/types", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        columns: [
          { id: "todo", label: "Todo", type: "to-do" },
          { id: "done", label: "Done", type: "closed" },
        ],
      }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json() as { columns: { id: string; type?: string }[] };
    expect(patched.columns.find((c) => c.id === "done")?.type).toBe("closed");

    const badRes = await app.request("/api/boards/types", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns: [{ id: "todo", label: "Todo", type: "nope" }] }),
    });
    expect(badRes.status).toBe(400);
  });
});

describe("DELETE /api/boards/:bid", () => {
  it("refuses to delete a board that still holds tasks, and the board survives", async () => {
    const app = makeApi(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    await app.request("/api/boards/test/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T1", status: "todo" }) });
    const res = await app.request("/api/boards/test", { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("board_not_empty");
    // Asserts the MESSAGE, not just the code — mirrors the session_cap precedent above: the count is
    // the part a bare status/code can't prove, and it's what tells the operator what to do next.
    expect(body.error.message).toContain("1 task");
    const stillThere = await app.request("/api/boards/test");
    expect(stillThere.status).toBe(200);
  });

  it("deletes an empty board", async () => {
    const app = makeApi(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const res = await app.request("/api/boards/test", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    const gone = await app.request("/api/boards/test");
    expect(gone.status).toBe(404);
  });

  it("404s deleting a board that doesn't exist", async () => {
    const app = makeApi(tmpDir);
    const res = await app.request("/api/boards/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

describe("POST + GET /api/boards/:bid/tasks", () => {
  it("creates a task and retrieves it via board state", async () => {
    const app = makeApi(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const taskRes = await app.request("/api/boards/test/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "My Task", status: "todo" }),
    });
    expect(taskRes.status).toBe(201);
    const task = await taskRes.json() as { id: string; title: string };
    expect(task.title).toBe("My Task");
    expect(task.id).toMatch(/^t_/);
  });

  it("lands a task created with no status in the board's landing column", async () => {
    const app = makeApi(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test2" }) });
    const res = await app.request("/api/boards/test2/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No status" }),
    });
    expect(res.status).toBe(201);
    const task = await res.json() as { status: string };
    expect(task.status).toBe("todo");
  });
});

describe("PATCH /api/boards/:bid/tasks/:tid", () => {
  it("updates task title", async () => {
    const app = makeApi(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const { id } = await (await app.request("/api/boards/test/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Old", status: "todo" }) })).json() as { id: string };
    const res = await app.request(`/api/boards/test/tasks/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New" }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json() as { title: string };
    expect(updated.title).toBe("New");
  });

  // The cap lives on the write path only: a description written before it must still load and be
  // readable, so the refusal has to come from the route, never from the stored schema.
  it("refuses a description past the cap, and accepts one at it", async () => {
    const app = makeApi(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const { id } = await (await app.request("/api/boards/test/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T", status: "todo" }) })).json() as { id: string };
    const patch = async (description: string) => app.request(`/api/boards/test/tasks/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    });

    const over = await patch("x".repeat(TASK_DESCRIPTION_MAX_CHARS + 1));
    expect(over.status).toBe(400);
    expect(JSON.stringify(await over.json())).toContain("the card states the task");

    expect((await patch("x".repeat(TASK_DESCRIPTION_MAX_CHARS))).status).toBe(200);
  });
});

describe("GET /api/state?board=", () => {
  it("returns board state with tasks and unassigned", async () => {
    const app = makeApi(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const res = await app.request("/api/state?board=test");
    expect(res.status).toBe(200);
    const body = await res.json() as { board: { id: string }; tasks: unknown[]; unassigned: unknown[] };
    expect(body.board.id).toBe("test");
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(Array.isArray(body.unassigned)).toBe(true);
  });
});

function makeApiWithSnapshot(dataDir: string, snapshot: Snapshot) {
  return createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage: createStorage(dataDir) });
}

async function createTaskOnTestBoard(app: ReturnType<typeof createApi>): Promise<string> {
  await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
  const { id } = await (await app.request("/api/boards/test/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T", status: "todo" }) })).json() as { id: string };
  return id;
}

interface StateLink { tabLabel: string; workspaceLabel: string; cwdSnapshot: string; name: string }
async function firstSessionLink(app: ReturnType<typeof createApi>): Promise<StateLink | undefined> {
  const state = await (await app.request("/api/state?board=test")).json() as { tasks: { sessions: StateLink[] }[] };
  return state.tasks[0]?.sessions[0];
}

describe("GET /api/state — the name a live card renders", () => {
  // The live card shows `name`, not the tab label (web/src/components/TaskCard.tsx), so this chain is
  // what the operator actually reads. Four steps: the operator's own Claude name, else the LIVE tab
  // label, else the stored link name, else the paneId.
  function snapshotWith(over: Partial<SessionRow>): Snapshot {
    return {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        env: "work-local", paneId: "w1-1", status: "working", agent: "claude",
        cwd: "/repo/x", tab: "live-tab", workspace: "demo-api",
        sessionId: null, recap: null, recapAt: null, recapStatus: null, recapSource: null,
        statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null,
        remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null, ...over,
      }],
    };
  }
  async function nameFor(over: Partial<SessionRow>, body: Record<string, unknown>): Promise<string | undefined> {
    const app = makeApiWithSnapshot(tmpDir, snapshotWith(over));
    const tid = await createTaskOnTestBoard(app);
    await app.request(`/api/boards/test/tasks/${tid}/attach`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "w1-1", ...body }),
    });
    // By task id, not tasks[0]: a test that calls this twice creates two tasks in the same board.
    const state = await (await app.request("/api/state?board=test")).json() as { tasks: { id: string; sessions: StateLink[] }[] };
    return state.tasks.find((t) => t.id === tid)?.sessions[0]?.name;
  }

  it("prefers the operator's own Claude name over the live tab label", async () => {
    expect(await nameFor({ claudeName: "auth-fix", claudeNameUserSet: true }, {})).toBe("auth-fix");
  });

  it("keeps the LIVE tab label when Claude derived the name itself", async () => {
    // Ungated, this would replace a label the operator set by hand with a Claude auto-name — and
    // nothing would ever push that name onto the tab, so board and terminal would disagree for good.
    expect(await nameFor({ claudeName: "Refactoring the poller", claudeNameUserSet: false }, {})).toBe("live-tab");
  });

  it("keeps the LIVE tab label when there is no registry record for the pane", async () => {
    expect(await nameFor({ claudeName: null, claudeNameUserSet: null }, {})).toBe("live-tab");
  });

  it("normalizes the Claude name, and falls through to the tab label when it normalizes away", async () => {
    expect(await nameFor({ claudeName: "  auth-fix  ", claudeNameUserSet: true }, {})).toBe("auth-fix");
    // claudeNameOf rejects only the exact empty string, so a whitespace-only name reaches the
    // normalizer and becomes "" — which must never render on a card.
    expect(await nameFor({ claudeName: "   ", claudeNameUserSet: true }, {})).toBe("live-tab");
  });

  it("skips herdr's '?' unknown-label sentinel, falling through to the stored name", async () => {
    // The tab-label step guards BOTH "" and "?" — herdr's sentinel for a label it does not know.
    // Without the "?" half a card would render a literal question mark as the session's name.
    expect(await nameFor({ tab: "?" }, { name: "stored-name" })).toBe("stored-name");
    expect(await nameFor({ tab: "?" }, { name: "" })).toBe("w1-1");
  });

  it("prefers the LIVE tab label over a stale stored name", async () => {
    // The one case that can distinguish the tab-label step from the stored-name step: everywhere else
    // the attach route stores liveRow.tab itself, so link.name and live.tab hold the same string and
    // dropping the step is invisible. link.name is a bind-time snapshot that the reconciler refreshes
    // only for user-set names, so without this step a card would show it forever.
    expect(await nameFor({}, { name: "stale-stored" })).toBe("live-tab");
  });

  it("falls back to the stored name only when there is no usable live label", async () => {
    expect(await nameFor({ tab: "?" }, { name: "stale-stored" })).toBe("stale-stored");
  });
});

describe("POST /api/boards/:bid/tasks/:tid/attach — label enrichment", () => {
  it("fills tab/workspace/cwd labels from the live poller snapshot", async () => {
    const snapshot: Snapshot = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        env: "work-local", paneId: "w1-1", status: "working", agent: "claude",
        cwd: "/repo/x", tab: "jira", workspace: "demo-api",
        sessionId: null, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
      }],
    };
    const app = makeApiWithSnapshot(tmpDir, snapshot);
    const tid = await createTaskOnTestBoard(app);
    const res = await app.request(`/api/boards/test/tasks/${tid}/attach`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "w1-1" }),
    });
    expect(res.status).toBe(200);
    const link = await firstSessionLink(app);
    expect(link?.tabLabel).toBe("jira");
    expect(link?.workspaceLabel).toBe("demo-api");
    expect(link?.cwdSnapshot).toBe("/repo/x");
    expect(link?.name).toBe("jira");
  });

  it("falls back to body-supplied labels when the session is not in the snapshot", async () => {
    const app = makeApiWithSnapshot(tmpDir, { envs: { "work-local": { reachable: true } }, sessions: [] });
    const tid = await createTaskOnTestBoard(app);
    const res = await app.request(`/api/boards/test/tasks/${tid}/attach`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "gone-1", tabLabel: "fallback-tab", workspaceLabel: "fallback-ws" }),
    });
    expect(res.status).toBe(200);
    const link = await firstSessionLink(app);
    expect(link?.tabLabel).toBe("fallback-tab");
    expect(link?.workspaceLabel).toBe("fallback-ws");
    // M1: no body name + session absent from snapshot must still yield a non-empty name (the
    // paneId), otherwise a detached card renders a bare "⚠ " with no identifying text.
    expect(link?.name).toBe("gone-1");
  });

  it("stores paneId as name when the live tab label is empty (not just the '?' sentinel)", async () => {
    // herdr.ts uses `?? "?"`, which does NOT substitute an empty-string tab label — so a live row
    // can carry tab: "". "" !== "?" must not slip through as an empty stored name.
    const snapshot: Snapshot = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        env: "work-local", paneId: "w2-1", status: "working", agent: "claude",
        cwd: "/repo/y", tab: "", workspace: "demo-api",
        sessionId: null, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
      }],
    };
    const app = makeApiWithSnapshot(tmpDir, snapshot);
    const tid = await createTaskOnTestBoard(app);
    const res = await app.request(`/api/boards/test/tasks/${tid}/attach`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "w2-1" }),
    });
    expect(res.status).toBe(200);
    const link = await firstSessionLink(app);
    expect(link?.name).toBe("w2-1");
  });
});

describe("POST /api/boards/:bid/tasks/:tid/attach — sessionId persistence", () => {
  it("stores the live row's stable sessionId on the link", async () => {
    const snapshot: Snapshot = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        env: "work-local", paneId: "w1-1", status: "working", agent: "claude",
        cwd: "/repo/x", tab: "jira", workspace: "demo-api",
        sessionId: "uuid-att", recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
      }],
    };
    const app = makeApiWithSnapshot(tmpDir, snapshot);
    const tid = await createTaskOnTestBoard(app);
    await app.request(`/api/boards/test/tasks/${tid}/attach`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "w1-1" }),
    });
    const state = await (await app.request("/api/state?board=test")).json() as { tasks: { sessions: { sessionId: string | null }[] }[] };
    expect(state.tasks[0]?.sessions[0]?.sessionId).toBe("uuid-att");
  });
});

describe("POST /api/boards/:bid/tasks/:tid/detach — remove one session link", () => {
  it("removes the attached session, leaving the task with no sessions", async () => {
    const snapshot: Snapshot = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        env: "work-local", paneId: "w1-1", status: "working", agent: "claude",
        cwd: "/repo/x", tab: "jira", workspace: "demo-api",
        sessionId: "uuid-d", recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
      }],
    };
    const app = makeApiWithSnapshot(tmpDir, snapshot);
    const tid = await createTaskOnTestBoard(app);
    await app.request(`/api/boards/test/tasks/${tid}/attach`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "w1-1" }),
    });
    const res = await app.request(`/api/boards/test/tasks/${tid}/detach`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "w1-1" }),
    });
    expect(res.status).toBe(200);
    const state = await (await app.request("/api/state?board=test")).json() as { tasks: { sessions: unknown[] }[]; unassigned: { paneId: string }[] };
    expect(state.tasks[0]?.sessions).toHaveLength(0);
    // …and the detached session returns to the Unassigned list (no longer claimed by any task).
    expect(state.unassigned.map((s) => s.paneId)).toContain("w1-1");
  });
});

describe("GET /api/state — sessionId churn-heal", () => {
  it("resolves a stale-paneId link by sessionId: un-detaches it and rewrites paneId to the live pane", async () => {
    const storage = createStorage(tmpDir);
    const now = Math.floor(Date.now() / 1000);
    // Seed a link whose stored paneId ("old-9") no longer exists — herdr restarted and reassigned it —
    // but whose sessionId ("uuid-9") is stable.
    await storage.withBoard("test", () => ({
      board: {
        id: "test", label: "Test", columns: [...DEFAULT_COLUMNS], spawnPresets: [], defaultSpawnPresetId: null,
        tasks: [{
          id: "t_seeded", title: "T", description: "", status: "todo", priority: null,
          sessions: [{ env: "work-local", paneId: "old-9", tabId: "", tabLabel: "", workspaceId: "", workspaceLabel: "", name: "sess", cwdSnapshot: "", sessionId: "uuid-9" }],
          createdAt: now, updatedAt: now, log: [],
        }],
      },
      result: undefined,
    }));
    const snapshot: Snapshot = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        env: "work-local", paneId: "new-9", status: "working", agent: "claude",
        cwd: "/repo", tab: "jira", workspace: "ws",
        sessionId: "uuid-9", recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
      }],
    };
    const app = makeApiWithSnapshot(tmpDir, snapshot);
    const state = await (await app.request("/api/state?board=test")).json() as {
      tasks: { sessions: { paneId: string; live: { detached: boolean; status: string } | null }[] }[];
      unassigned: { paneId: string }[];
    };
    const link = state.tasks[0]?.sessions[0];
    expect(link?.live?.detached).toBe(false);   // resolved → live, not detached
    expect(link?.paneId).toBe("new-9");          // healed to the current pane
    expect(link?.live?.status).toBe("working");
    // …and the healed session must not double-show as unassigned (claimed by sessionId).
    expect(state.unassigned).toHaveLength(0);
  });

  it("does not mis-bind a link to a REUSED paneId — it trusts its own sessionId over the stale pane", async () => {
    const storage = createStorage(tmpDir);
    const now = Math.floor(Date.now() / 1000);
    // Two sessions on one card: A stored at p1, B stored at p2.
    await storage.withBoard("test", () => ({
      board: {
        id: "test", label: "Test", columns: [...DEFAULT_COLUMNS], spawnPresets: [], defaultSpawnPresetId: null,
        tasks: [{
          id: "t_seeded", title: "T", description: "", status: "todo", priority: null,
          sessions: [
            { env: "work-local", paneId: "p1", tabId: "", tabLabel: "", workspaceId: "", workspaceLabel: "", name: "A", cwdSnapshot: "", sessionId: "uuid-A" },
            { env: "work-local", paneId: "p2", tabId: "", tabLabel: "", workspaceId: "", workspaceLabel: "", name: "B", cwdSnapshot: "", sessionId: "uuid-B" },
          ],
          createdAt: now, updatedAt: now, log: [],
        }],
      },
      result: undefined,
    }));
    // Churn: uuid-A's session now occupies p2 (B's old pane); uuid-B is gone. The naive "paneId first"
    // resolver would bind B's link to A's live row (both point at p2) — it must not.
    const snapshot: Snapshot = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        env: "work-local", paneId: "p2", status: "working", agent: "claude",
        cwd: "/r", tab: "t", workspace: "w", sessionId: "uuid-A", recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
      }],
    };
    const app = makeApiWithSnapshot(tmpDir, snapshot);
    const state = await (await app.request("/api/state?board=test")).json() as {
      tasks: { sessions: { paneId: string; sessionId: string | null; live: { detached: boolean } | null }[] }[];
    };
    const sessions = state.tasks[0]?.sessions ?? [];
    const a = sessions[0];
    const b = sessions[1];
    expect(a?.sessionId).toBe("uuid-A");
    expect(a?.paneId).toBe("p2");           // A heals to its current pane
    expect(a?.live?.detached).toBe(false);
    expect(b?.sessionId).toBe("uuid-B");
    expect(b?.live?.detached).toBe(true);   // B is NOT bound to A's row despite the shared pane
  });

  it("keeps a link detached when its sessionId matches no live session (a genuinely dead session)", async () => {
    const storage = createStorage(tmpDir);
    const now = Math.floor(Date.now() / 1000);
    await storage.withBoard("test", () => ({
      board: {
        id: "test", label: "Test", columns: [...DEFAULT_COLUMNS], spawnPresets: [], defaultSpawnPresetId: null,
        tasks: [{
          id: "t_seeded", title: "T", description: "", status: "todo", priority: null,
          sessions: [{ env: "work-local", paneId: "old-9", tabId: "", tabLabel: "", workspaceId: "", workspaceLabel: "", name: "sess", cwdSnapshot: "", sessionId: "uuid-dead" }],
          createdAt: now, updatedAt: now, log: [],
        }],
      },
      result: undefined,
    }));
    const app = makeApiWithSnapshot(tmpDir, { envs: { "work-local": { reachable: true } }, sessions: [] });
    const state = await (await app.request("/api/state?board=test")).json() as { tasks: { sessions: { paneId: string; live: { detached: boolean } | null }[] }[] };
    const link = state.tasks[0]?.sessions[0];
    expect(link?.live?.detached).toBe(true);
    expect(link?.paneId).toBe("old-9"); // unresolved → stored paneId untouched
  });

  it("surfaces a same-pane session replacement (/new) in Unassigned instead of hiding it", async () => {
    const storage = createStorage(tmpDir);
    const now = Math.floor(Date.now() / 1000);
    // The user ran `/new` in an attached session's terminal: herdr keeps the pane id ("wQ:p4") but
    // Claude registers a NEW session uuid. The link's stored sessionId is now stale while its stored
    // paneId still matches the live pane. buildBoardState resolves the stale link by sessionId (→
    // detached), so the live pane must NOT stay claimed by that link's paneId — otherwise the new
    // session vanishes from BOTH the card and the pool.
    await storage.withBoard("test", () => ({
      board: {
        id: "test", label: "Test", columns: [...DEFAULT_COLUMNS], spawnPresets: [], defaultSpawnPresetId: null,
        tasks: [{
          id: "t_seeded", title: "T", description: "", status: "todo", priority: null,
          sessions: [{ env: "work-local", paneId: "wQ:p4", tabId: "", tabLabel: "", workspaceId: "", workspaceLabel: "", name: "sess", cwdSnapshot: "", sessionId: "uuid-old" }],
          createdAt: now, updatedAt: now, log: [],
        }],
      },
      result: undefined,
    }));
    const snapshot: Snapshot = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        env: "work-local", paneId: "wQ:p4", status: "done", agent: "claude",
        cwd: "/repo", tab: "jira", workspace: "ws",
        sessionId: "uuid-new", recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
      }],
    };
    const app = makeApiWithSnapshot(tmpDir, snapshot);
    const state = await (await app.request("/api/state?board=test")).json() as {
      tasks: { sessions: { paneId: string; live: { detached: boolean } | null }[] }[];
      unassigned: { paneId: string; sessionId: string | null }[];
    };
    // The stale link stays detached (its original session genuinely ended)…
    expect(state.tasks[0]?.sessions[0]?.live?.detached).toBe(true);
    // …and the NEW live session on the same pane surfaces in Unassigned, not nowhere.
    expect(state.unassigned.map((s) => s.sessionId)).toContain("uuid-new");
    expect(state.unassigned.map((s) => s.paneId)).toContain("wQ:p4");
  });
});

describe("POST /api/boards/:bid/tasks/from-session — name fallback", () => {
  it("falls back to paneId when the client sends no name (the real client never does)", async () => {
    const app = makeApiWithSnapshot(tmpDir, { envs: { "work-local": { reachable: true } }, sessions: [] });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const res = await app.request("/api/boards/test/tasks/from-session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "From Sess", env: "work-local", paneId: "fs-1" }),
    });
    expect(res.status).toBe(201);
    const link = await firstSessionLink(app);
    expect(link?.name).toBe("fs-1");
  });
});

describe("POST /api/boards/:bid/tasks/from-session — claim check", () => {
  it("returns 409 conflict when the session is already carded (the contract the web alert surfaces)", async () => {
    const app = makeApi(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const first = await app.request("/api/boards/test/tasks/from-session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "From Sess", env: "work-local", paneId: "fs-1" }),
    });
    expect(first.status).toBe(201);
    const second = await app.request("/api/boards/test/tasks/from-session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Again", env: "work-local", paneId: "fs-1" }),
    });
    expect(second.status).toBe(409);
    const err = await second.json() as { error: { code: string; message: string } };
    expect(err.error.code).toBe("conflict");
    expect(err.error.message).toBe("session already assigned");
  });
});

describe("GET /api/state?board= — attention", () => {
  it("includes the poller's attention map in the BoardState payload", async () => {
    const attention = { "work-local:w1-1": { state: "blocked" as const, since: 1, sessionName: "jira", lastLines: "x", captured: true } };
    const app = createApi({ poller: { ...poller, getAttention: () => attention }, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const res = await app.request("/api/state?board=test");
    const body = await res.json() as { attention: unknown };
    expect(body.attention).toEqual(attention);
  });
});

describe("GET /api/state — name healing for persisted empty-name links", () => {
  it("renders paneId when a stored link has an empty name (pre-fix on-disk records)", async () => {
    // Reproduces the 8 production records that persisted name: "" before this fix. The session is
    // absent from the snapshot → detached → the card renders "⚠ {name}", so buildBoardState must
    // supply the paneId rather than "" (the read-time `live?.tab` backfill is dead when detached).
    const storage = createStorage(tmpDir);
    const now = Math.floor(Date.now() / 1000);
    await storage.withBoard("test", () => ({
      board: {
        id: "test", label: "Test", columns: [...DEFAULT_COLUMNS], spawnPresets: [], defaultSpawnPresetId: null,
        tasks: [{
          id: "t_seeded", title: "T", description: "", status: "todo", priority: null,
          sessions: [{ env: "work-local", paneId: "old-1", tabId: "", tabLabel: "", workspaceId: "", workspaceLabel: "", name: "", cwdSnapshot: "", sessionId: null }],
          createdAt: now, updatedAt: now, log: [],
        }],
      },
      result: undefined,
    }));
    const app = makeApiWithSnapshot(tmpDir, { envs: { "work-local": { reachable: true } }, sessions: [] });
    const link = await firstSessionLink(app);
    expect(link?.name).toBe("old-1");
  });
});

function makeApiWithSpawn(dataDir: string) {
  const spawn = vi.fn(async (_opts: unknown): Promise<SpawnResult> => ({
    paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1",
    workspaceLabel: "corral", tabLabel: "t-a", cwdSnapshot: "/proj", idempotent: false,
  }));
  const listWorkspaces = vi.fn().mockResolvedValue([{ workspace_id: "w1", label: "corral" }]);
  const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(dataDir), spawn, listWorkspaces });
  return { app, spawn, listWorkspaces };
}

describe("GET /api/envs/:env/spawn-targets", () => {
  it("returns { spaces, repos } — herdr spaces to join + configured repos to create from", async () => {
    // Deterministic env with known repos (ENVIRONMENTS' repos are user-config-dependent).
    const envs = [{ id: "e1", label: "E1", kind: "local" as const, claudeConfigDirs: [], spawnCommand: "claude", repos: { corral: "/p/corral", "demo-api": "/p/api" } }];
    const listWorkspaces = vi.fn().mockResolvedValue([{ workspace_id: "w1", label: "corral" }]);
    const app = createApi({ poller, envs, storage: createStorage(tmpDir), listWorkspaces });
    const res = await app.request("/api/envs/e1/spawn-targets");
    expect(res.status).toBe(200);
    const body = await res.json() as { spaces: { workspaceId: string; label: string }[]; repos: { name: string }[] };
    expect(body.spaces).toEqual([{ workspaceId: "w1", label: "corral" }]);
    expect(body.repos).toEqual([{ name: "corral" }, { name: "demo-api" }]); // names only — paths stay server-side
  });

  it("400s on an unknown env", async () => {
    const { app } = makeApiWithSpawn(tmpDir);
    expect((await app.request("/api/envs/nope/spawn-targets")).status).toBe(400);
  });

  it("still returns the configured repos when the herdr list throws (env unreachable)", async () => {
    const envs = [{ id: "e1", label: "E1", kind: "local" as const, claudeConfigDirs: [], spawnCommand: "claude", repos: { corral: "/p/corral" } }];
    const listWorkspaces = vi.fn().mockRejectedValue(new Error("timeout"));
    const app = createApi({ poller, envs, storage: createStorage(tmpDir), listWorkspaces });
    const res = await app.request("/api/envs/e1/spawn-targets");
    expect(res.status).toBe(200);
    const body = await res.json() as { spaces: unknown[]; repos: { name: string }[] };
    expect(body.spaces).toEqual([]);            // no join targets when unreachable
    expect(body.repos).toEqual([{ name: "corral" }]); // …but repos still offered
  });
});

describe("POST /api/boards/:bid/tasks/:tid/spawn", () => {
  it("passes spawnCommand + targetWorkspaceId and returns the link (with env)", async () => {
    const { app, spawn } = makeApiWithSpawn(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const { id } = await (await app.request("/api/boards/test/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "My Task", status: "todo" }) })).json() as { id: string };
    const res = await app.request(`/api/boards/test/tasks/${id}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { paneId: string; env: string; idempotent: boolean };
    expect(body.paneId).toBe("w1:p2");
    expect(body.env).toBe("work-local");
    const call = spawn.mock.calls[0]?.[0] as { spawnCommand: string; targetWorkspaceId: string | null };
    expect(call.spawnCommand).toBe("claude"); // work-local default (no spawnCommand set)
    expect(call.targetWorkspaceId).toBeNull();
  });

  it("passes the request's repo (the picker's 'new from repo' choice) to the spawner", async () => {
    const { app, spawn } = makeApiWithSpawn(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    // Task has no stored repo — the repo comes from the spawn request (the "＋ New from repo" pick).
    const { id } = await (await app.request("/api/boards/test/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "My Task", status: "todo" }) })).json() as { id: string };
    const res = await app.request(`/api/boards/test/tasks/${id}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral" }),
    });
    expect(res.status).toBe(200);
    const call = spawn.mock.calls[0]?.[0] as { repo: string | null };
    expect(call.repo).toBe("corral");
  });

  it("does not swallow spawn errors (returns 500 with message)", async () => {
    const spawn = vi.fn().mockRejectedValue(new Error("pane run failed"));
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir), spawn, listWorkspaces: vi.fn().mockResolvedValue([]) });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const { id } = await (await app.request("/api/boards/test/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T", status: "todo" }) })).json() as { id: string };
    const res = await app.request(`/api/boards/test/tasks/${id}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral" }),
    });
    expect(res.status).toBe(500);
    const err = await res.json() as { error: { message: string } };
    expect(err.error.message).toContain("pane run failed");
  });
});

describe("POST /api/boards/:bid/tasks/:tid/spawn — idempotent adoption of an already-bound pane", () => {
  it("heals a churn-moved link's location fields instead of returning the stale pane", async () => {
    // The stored link's pane moved (herdr restart) — same Claude session, new paneId. linkBindsSession
    // matches it via the sessionId-only disjunct even though paneId differs; the adoption must rewrite
    // the link's paneId/tabId/workspace to the fresh spawn result, not hand back the pre-move pane.
    const snapshot: Snapshot = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        env: "work-local", paneId: "w1-new", status: "idle", agent: "claude",
        cwd: "/repo/x", tab: "renamed-tab", workspace: "new-ws",
        sessionId: "sess-abc", recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
      }],
    };
    const spawn = vi.fn(async (_opts: unknown): Promise<SpawnResult> => ({
      paneId: "w1-new", tabId: "t-new", workspaceId: "w-new",
      workspaceLabel: "new-ws", tabLabel: "renamed-tab", cwdSnapshot: "/repo/x", idempotent: true,
    }));
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage: createStorage(tmpDir), spawn, listWorkspaces: vi.fn().mockResolvedValue([]) });
    const tid = await createTaskOnTestBoard(app);
    // Seed the pre-move link directly (its paneId "w1-old" is now dead — attach would need a live row).
    const storage = createStorage(tmpDir);
    await storage.withBoard("test", (b) => {
      if (b === null) return { board: null, result: undefined };
      const t = b.tasks.find((x) => x.id === tid);
      if (t === undefined) return { board: b, result: undefined };
      return {
        board: { ...b, tasks: b.tasks.map((x) => x.id === tid ? { ...x, sessions: [{ env: "work-local", paneId: "w1-old", tabId: "t-old", tabLabel: "old-tab", workspaceId: "w-old", workspaceLabel: "old-ws", name: "old-tab", cwdSnapshot: "/repo/x", sessionId: "sess-abc" }] } : x) },
        result: undefined,
      };
    });

    const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral", name: "second-name" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { idempotent: boolean; paneId: string };
    expect(body.idempotent).toBe(true);
    expect(body.paneId).toBe("w1-new"); // healed to the fresh pane, not the stale "w1-old"
    const state = await (await app.request("/api/state?board=test")).json() as { tasks: { sessions: { paneId: string; tabLabel: string }[] }[] };
    expect(state.tasks[0]?.sessions).toHaveLength(1); // still no duplicate
    expect(state.tasks[0]?.sessions[0]?.paneId).toBe("w1-new");
  });

  it("does not append a duplicate link when the adopted pane is already on this card", async () => {
    // Reproduces the duplicate-session-row bug: spawnSession's join-path rejoin scan can hand back a
    // pane that is ALREADY linked to this very card (e.g. under a different requested name). Appending
    // unconditionally puts two links on the card resolving to the same live session.
    const snapshot: Snapshot = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        env: "work-local", paneId: "w1-1", status: "idle", agent: "claude",
        cwd: "/repo/x", tab: "already-here", workspace: "demo-api",
        sessionId: "sess-abc", recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
      }],
    };
    const spawn = vi.fn(async (_opts: unknown): Promise<SpawnResult> => ({
      paneId: "w1-1", tabId: "w1-1", workspaceId: "w1",
      workspaceLabel: "demo-api", tabLabel: "already-here", cwdSnapshot: "/repo/x", idempotent: true,
    }));
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage: createStorage(tmpDir), spawn, listWorkspaces: vi.fn().mockResolvedValue([]) });
    const tid = await createTaskOnTestBoard(app);
    await app.request(`/api/boards/test/tasks/${tid}/attach`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "w1-1" }),
    });

    const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral", name: "second-name" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { idempotent: boolean };
    expect(body.idempotent).toBe(true);
    const state = await (await app.request("/api/state?board=test")).json() as { tasks: { sessions: unknown[] }[] };
    expect(state.tasks[0]?.sessions).toHaveLength(1); // no duplicate link
  });
});

describe("POST /api/boards/:bid/tasks/:tid/spawn — next free session suffix", () => {
  async function seedTaskWithSessionNames(dataDir: string, names: readonly string[]): Promise<{ app: ReturnType<typeof createApi>; spawn: ReturnType<typeof vi.fn>; tid: string }> {
    const { app, spawn } = makeApiWithSpawn(dataDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const { id } = await (await app.request("/api/boards/test/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "My Task", status: "todo" }) })).json() as { id: string };
    // Inject pre-existing sessions with the given (spawn-style) names via a sibling storage handle.
    const storage = createStorage(dataDir);
    await storage.withBoard("test", (b) => {
      if (b === null) return { board: null, result: undefined };
      const sessions = names.map((name, i) => ({ env: "work-local", paneId: `w1:pS${String(i)}`, tabId: "", tabLabel: "", workspaceId: "", workspaceLabel: "", name, cwdSnapshot: "", sessionId: null }));
      return { board: { ...b, tasks: b.tasks.map((t) => t.id === id ? { ...t, sessions } : t) }, result: undefined };
    });
    return { app, spawn, tid: id };
  }

  it("passes suffix 'b' and stores name '<slug>-b' when '<slug>-a' already exists", async () => {
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, ["my-task-a"]);
    const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral" }),
    });
    expect(res.status).toBe(200);
    const call = spawn.mock.calls[0]?.[0] as { sessionName: string };
    expect(call.sessionName).toBe("my-task-b");
    const body = await res.json() as { name: string };
    expect(body.name).toBe("my-task-b");
  });

  it("picks 'd' (not a cap) when a, b, c are already taken", async () => {
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, ["my-task-a", "my-task-b", "my-task-c"]);
    const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral" }),
    });
    expect(res.status).toBe(200);
    const call = spawn.mock.calls[0]?.[0] as { sessionName: string };
    expect(call.sessionName).toBe("my-task-d");
  });

  it("409s with session_cap once the card holds 26 sessions", async () => {
    const allLetters = Array.from({ length: 26 }, (_, i) => `my-task-${String.fromCharCode(97 + i)}`);
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, allLetters);
    const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral" }),
    });
    expect(res.status).toBe(409);
    const err = await res.json() as { error: { code: string; message: string } };
    expect(err.error.code).toBe("session_cap");
    // Asserts the MESSAGE, not just the code. This fixture fills every a–z name, so BOTH 409 branches
    // can fire and they share the `session_cap` code — on the code alone the test passed even with the
    // counted cap disabled, because the "no free session name" branch answered instead. The message is
    // what tells the two apart.
    expect(err.error.message).toContain("already has 26 sessions");
    expect(spawn).not.toHaveBeenCalled();
  });

  // The card slug is NOT prefixed any more. It used to take the length budget first, so truncation
  // ate the requested name — the informative half — and it degenerated to "task" for any title
  // without Latin characters. The agent supplies the whole {slug}-{name}.
  it("uses the requested name as the session name, with no card prefix", async () => {
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, []);
    const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral", name: "WM stake RC toggle" }),
    });
    expect(res.status).toBe(200);
    const call = spawn.mock.calls[0]?.[0] as { sessionName: string };
    expect(call.sessionName).toBe("wm-stake-rc-toggle");
    const body = await res.json() as { name: string };
    expect(body.name).toBe("wm-stake-rc-toggle"); // the STORED link name is the same string
  });

  // A stored link name is not always a string this route composed — attach and from-session take it
  // from the client — so the taken-set must be compared in slugified form. Raw, the candidate
  // `fix-the-auth-bug` does not match the stored "Fix the auth bug" and a SECOND session gets the
  // identical `--name` and tab label. Only reachable since the requested name stopped being prefixed
  // with the card slug.
  it("suffixes against a stored name that only matches once slugified", async () => {
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, ["Fix the auth bug"]);
    const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral", name: "Fix the auth bug" }),
    });
    expect(res.status).toBe(200);
    const call = spawn.mock.calls[0]?.[0] as { sessionName: string };
    expect(call.sessionName).toBe("fix-the-auth-bug-a");
  });

  // A name past the OLD 56-character bound must survive. NAME_RE hardcoded that bound as {0,55}
  // while gating every candidate, so raising NAME_MAX alone turned every longer name into a 409.
  it("accepts a name longer than the old 56-character bound", async () => {
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, []);
    const long = "b".repeat(70);
    const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral", name: long }),
    });
    expect(res.status).toBe(200);
    const call = spawn.mock.calls[0]?.[0] as { sessionName: string };
    expect(call.sessionName).toBe(long);
  });

  it("falls back to <slug>-<letter> when no name is supplied", async () => {
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, ["my-task-a"]);
    await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral" }),
    });
    const call = spawn.mock.calls[0]?.[0] as { sessionName: string };
    expect(call.sessionName).toBe("my-task-b");
  });

  it("appends a letter when the requested name is already taken", async () => {
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, ["rc-toggle-ui"]);
    await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral", name: "RC toggle UI" }),
    });
    const call = spawn.mock.calls[0]?.[0] as { sessionName: string };
    expect(call.sessionName).toBe("rc-toggle-ui-a");
  });

  // The case the design exists for. `sanitizeSlug` keeps only [a-z0-9], so a title in any non-Latin
  // script used to reduce to the sentinel "task" and every session on every such card was named
  // task-a, task-b — indistinguishable wherever the name is actually read.
  it("derives a name from the task id when the card title has no Latin characters", async () => {
    const { app, spawn } = makeApiWithSpawn(tmpDir);
    await app.request("/api/boards", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Test" }),
    });
    const { id } = await (await app.request("/api/boards/test/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Починить зомби-ридер в поллере", status: "todo" }),
    })).json() as { id: string };
    const res = await app.request(`/api/boards/test/tasks/${id}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: "w1" }),
    });
    expect(res.status).toBe(200);
    const call = spawn.mock.calls[0]?.[0] as { sessionName: string };
    expect(call.sessionName).not.toBe("task-a");          // the old degenerate name
    expect(call.sessionName).toMatch(/^t-/);              // derived from the task id
    expect(call.sessionName).toMatch(/^[a-z0-9][a-z0-9-]*$/); // and inside the launch-flag charset
  });

  it("rejects a name longer than 128 characters", async () => {
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, []);
    const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral", name: "x".repeat(129) }),
    });
    expect(res.status).toBe(400);
    expect(spawn).not.toHaveBeenCalled();
  });

  // The bound is on the RAW input; slugify caps the result at NAME_MAX regardless. 65 characters used
  // to be rejected outright, which refused names the new cap is wide enough to carry.
  it("accepts a 100-character name and caps the result at NAME_MAX", async () => {
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, []);
    const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral", name: "x".repeat(100) }),
    });
    expect(res.status).toBe(200);
    const call = spawn.mock.calls[0]?.[0] as { sessionName: string };
    expect(call.sessionName).toBe("x".repeat(NAME_MAX));
  });

  it("forwards a valid model to the spawner", async () => {
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, []);
    await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral", model: "fable" }),
    });
    const call = spawn.mock.calls[0]?.[0] as { model?: string };
    expect(call.model).toBe("fable");
  });

  it("omits model from the spawn options entirely when none is chosen", async () => {
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, []);
    await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral" }),
    });
    // exactOptionalPropertyTypes: absent must mean ABSENT, not `undefined` — spawn.ts branches on
    // `opts.model === undefined`, and "inherit the last-used model" is the default.
    expect(spawn).toHaveBeenCalledOnce();
    expect(Object.hasOwn(spawn.mock.calls[0]?.[0] ?? {}, "model")).toBe(false);
  });

  it("accepts a model carrying the [1m] context-window suffix", async () => {
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, []);
    const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral", model: "claude-sonnet-5[1m]" }),
    });
    expect(res.status).toBe(200);
    const call = spawn.mock.calls[0]?.[0] as { model?: string };
    expect(call.model).toBe("claude-sonnet-5[1m]");
  });

  // corral keeps no allowlist, so the shape check must not become one by omission. These are the id
  // forms Claude Code takes on non-first-party providers; a class without `:` / `@` / uppercase
  // refused exactly the ids an operator has to type out in full.
  it.each([
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0", // Bedrock
    "anthropic.claude-3-5-sonnet-20241022-v2:0",    // Bedrock
    "claude-sonnet-4-5@20250929",                   // Vertex
    "Claude-Opus-4-5",                              // uppercase
  ])("accepts the full provider model id %j", async (model) => {
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, []);
    const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral", model }),
    });
    expect(res.status).toBe(200);
    expect(spawn).toHaveBeenCalledOnce();
    const call = spawn.mock.calls[0]?.[0] as { model?: string };
    expect(call.model).toBe(model);
  });

  it("rejects a model carrying shell metacharacters", async () => {
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, []);
    for (const model of ["; rm -rf /", "--dangerously-skip-permissions", "a b", "$(id)"]) {
      const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral", model }),
      });
      expect(res.status, model).toBe(400);
      expect((await res.json() as { error: { message: string } }).error.message, model).toContain("model");
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("passes remoteControl through to the spawner, and omits it entirely by default", async () => {
    const on = await seedTaskWithSessionNames(tmpDir, []);
    await on.app.request(`/api/boards/test/tasks/${on.tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral", remoteControl: true }),
    });
    expect((on.spawn.mock.calls[0]?.[0] as { remoteControl?: boolean }).remoteControl).toBe(true);

    const off = await seedTaskWithSessionNames(tmpDir, []);
    await off.app.request(`/api/boards/test/tasks/${off.tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral" }),
    });
    // ABSENT, not `false` — exactOptionalPropertyTypes makes those different types.
    expect(off.spawn).toHaveBeenCalledOnce();
    expect(Object.hasOwn(off.spawn.mock.calls[0]?.[0] ?? {}, "remoteControl")).toBe(false);
  });

  // A.2: the cap is COUNTED, not inferred from letter exhaustion. A named spawn need not consume a
  // letter, so "no free letter" stopped being the same question as "too many sessions". These 26
  // links are ATTACHED-style names — no letter of `my-task-<a..z>` is taken, and it still caps.
  it("409s with session_cap at 26 sessions whatever they are named", async () => {
    const names = Array.from({ length: 26 }, (_, i) => `attached-${String(i)}`);
    const { app, spawn, tid } = await seedTaskWithSessionNames(tmpDir, names);
    const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("session_cap");
    expect(spawn).not.toHaveBeenCalled();
  });
});

async function makeTwoBoards(app: ReturnType<typeof createApi>): Promise<string> {
  await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Src" }) });
  await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Dst" }) });
  const { id } = await (await app.request("/api/boards/src/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Move me", status: "doing" }) })).json() as { id: string };
  return id;
}

describe("POST /api/boards/:bid/tasks/:tid/move", () => {
  it("moves a task to another board, preserving status when the column exists", async () => {
    const app = makeApi(tmpDir);
    const id = await makeTwoBoards(app);
    const res = await app.request(`/api/boards/src/tasks/${id}/move`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toBoardId: "dst" }),
    });
    expect(res.status).toBe(200);
    const src = await (await app.request("/api/state?board=src")).json() as { tasks: unknown[] };
    const dst = await (await app.request("/api/state?board=dst")).json() as { tasks: { id: string; status: string }[] };
    expect(src.tasks).toHaveLength(0);
    expect(dst.tasks).toHaveLength(1);
    expect(dst.tasks[0]?.id).toBe(id);
    expect(dst.tasks[0]?.status).toBe("doing"); // dst has the default columns incl. "doing"
  });

  it("400s on a malformed task id (fails TID_RE)", async () => {
    const app = makeApi(tmpDir);
    await makeTwoBoards(app);
    const res = await app.request(`/api/boards/src/tasks/t_bad/move`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toBoardId: "dst" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s on a well-formed but absent task id", async () => {
    const app = makeApi(tmpDir);
    await makeTwoBoards(app);
    const res = await app.request(`/api/boards/src/tasks/t_abcdefg/move`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toBoardId: "dst" }),
    });
    expect(res.status).toBe(404);
  });

  it("404s when the target board is missing", async () => {
    const app = makeApi(tmpDir);
    const id = await makeTwoBoards(app);
    const res = await app.request(`/api/boards/src/tasks/${id}/move`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toBoardId: "ghost" }),
    });
    expect(res.status).toBe(404);
  });

  it("maps status to the target's first column when the source status is absent there", async () => {
    const app = makeApi(tmpDir);
    const storage = createStorage(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Src" }) });
    const { id } = await (await app.request("/api/boards/src/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T", status: "doing" }) })).json() as { id: string };
    // target board with custom columns that do NOT include "doing"
    await storage.withBoard("custom", () => ({
      board: { id: "custom", label: "Custom", columns: [{ id: "backlog", label: "Backlog" }, { id: "done", label: "Done" }], tasks: [], spawnPresets: [], defaultSpawnPresetId: null },
      result: undefined,
    }));
    const res = await app.request(`/api/boards/src/tasks/${id}/move`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toBoardId: "custom" }),
    });
    expect(res.status).toBe(200);
    const dst = await (await app.request("/api/state?board=custom")).json() as { tasks: { status: string }[] };
    expect(dst.tasks[0]?.status).toBe("backlog");
  });

  it("carries the task's session links to the target (fresh read under the combined lock, #6)", async () => {
    const app = makeApi(tmpDir);
    const storage = createStorage(tmpDir);
    const id = await makeTwoBoards(app); // task on src, dst empty
    await storage.withBoard("src", (b) => {
      if (b === null) return { board: null, result: undefined };
      return {
        board: { ...b, tasks: b.tasks.map((t) => t.id === id ? { ...t, sessions: [{ env: "work-local", paneId: "w1:p1", tabId: "w1:t1", tabLabel: "x", workspaceId: "w1", workspaceLabel: "c", name: "s", cwdSnapshot: "/c", sessionId: null }] } : t) },
        result: undefined,
      };
    });
    const res = await app.request(`/api/boards/src/tasks/${id}/move`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toBoardId: "dst" }),
    });
    expect(res.status).toBe(200);
    expect(storage.getBoard("dst")?.tasks[0]?.sessions).toHaveLength(1);
    expect(storage.getBoard("dst")?.tasks[0]?.sessions[0]?.paneId).toBe("w1:p1");
    expect(storage.getBoard("src")?.tasks).toHaveLength(0); // gone from source, not duplicated
  });
});

describe("GET /api/sessions/:env/:sessionId/last-active", () => {
  const uuid = "11111111-2222-3333-4444-555555555555";
  it("returns lastActive from the injected reader and caches it", async () => {
    let calls = 0;
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
      lastActivity: () => { calls += 1; return Promise.resolve(1_700_000_000_000); },
    });
    const r1 = await app.request(`/api/sessions/work-local/${uuid}/last-active`);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ lastActive: 1_700_000_000_000 });
    await app.request(`/api/sessions/work-local/${uuid}/last-active`); // second hit → cache
    expect(calls).toBe(1);
  });

  it("400s on a bad sessionId", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir), lastActivity: () => Promise.resolve(null) });
    const res = await app.request(`/api/sessions/work-local/not-a-uuid/last-active`);
    expect(res.status).toBe(400);
  });
});

async function seedTaskWithLink(app: ReturnType<typeof createApi>, storage: ReturnType<typeof createStorage>, sessionId: string | null = "11111111-2222-3333-4444-555555555555"): Promise<void> {
  await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "T" }) });
  await storage.withBoard("t", (b) => {
    if (b === null) return { board: null, result: undefined };
    const task = {
      id: "t_aaaaaaa", title: "x", description: "", status: "todo", priority: null,
      sessions: [{ env: "work-local", paneId: "w1:p1", tabId: "w1:t1", tabLabel: "x", workspaceId: "w1", workspaceLabel: "c", name: "x-a", cwdSnapshot: "/c", sessionId }],
      createdAt: 1, updatedAt: 1, log: [],
    };
    return { board: { ...b, tasks: [task] }, result: undefined };
  });
}

describe("POST close (herdr pane close)", () => {
  const SID = "11111111-2222-3333-4444-555555555555"; // seedTaskWithLink's default link sessionId
  const liveAt = (paneId: string, sessionId: string | null): Snapshot => ({
    envs: { "work-local": { reachable: true } },
    sessions: [makeLiveRow({ paneId, sessionId, tabId: "w1:t1" })],
  });

  // close now kills the PANE (herdr pane close cascades pane → tab → workspace); it requires a live
  // row for env:paneId whose sessionId matches the link, so a detached / reused pane is never closed.
  it("closes the pane and leaves task.sessions unchanged", async () => {
    const closed: string[] = [];
    const storage = createStorage(tmpDir);
    const app = createApi({
      poller: { ...poller, getSnapshot: () => liveAt("w1:p1", SID) },
      envs: ENVIRONMENTS, storage,
      closePaneFn: (_e, paneId) => { closed.push(paneId); return Promise.resolve(); },
    });
    await seedTaskWithLink(app, storage);
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w1:p1/close", { method: "POST" });
    expect(res.status).toBe(200);
    expect(closed).toEqual(["w1:p1"]);
    expect(storage.getBoard("t")?.tasks[0]?.sessions).toHaveLength(1); // link retained
  });

  it("502s when pane close throws, session retained", async () => {
    const storage = createStorage(tmpDir);
    const app = createApi({
      poller: { ...poller, getSnapshot: () => liveAt("w1:p1", SID) },
      envs: ENVIRONMENTS, storage,
      closePaneFn: () => Promise.reject(new Error("unreachable")),
    });
    await seedTaskWithLink(app, storage);
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w1:p1/close", { method: "POST" });
    expect(res.status).toBe(502);
    expect(storage.getBoard("t")?.tasks[0]?.sessions).toHaveLength(1); // link retained
  });

  it("404s when the pane is not linked to the task", async () => {
    const storage = createStorage(tmpDir);
    const app = createApi({ poller, envs: ENVIRONMENTS, storage, closePaneFn: () => Promise.resolve() });
    await seedTaskWithLink(app, storage);
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w9:p9/close", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("404s (no_live_pane) when the link exists but the pane is not live", async () => {
    const storage = createStorage(tmpDir);
    const app = createApi({ poller, envs: ENVIRONMENTS, storage, closePaneFn: () => Promise.resolve() });
    await seedTaskWithLink(app, storage);
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w1:p1/close", { method: "POST" });
    expect(res.status).toBe(404);
    // The CODE, not just the status: the web client branches on it to tell "already gone" (the end
    // state the caller asked for) from a refusal about a different session. Renaming it here would
    // silently turn a successful close back into a red error in the UI.
    expect(await res.json()).toMatchObject({ error: { code: "no_live_pane" } });
  });

  // A null-sessionId link (no herdr integration, or the pre-backfill /new window) can't be verified by
  // sessionId. Prove ownership by the live row's tab identity instead, so a churn-reused pane whose tab
  // now differs is refused rather than closed out from under a stranger.
  it("409s a null-sessionId link when the live pane's tab identity differs (churn-reused)", async () => {
    const storage = createStorage(tmpDir);
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "w1:p1", sessionId: "99999999-8888-7777-6666-555555555555", tabId: "stranger:t", workspaceId: "w9" })] };
    const closed: string[] = [];
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage, closePaneFn: (_e, p) => { closed.push(p); return Promise.resolve(); } });
    await seedTaskWithLink(app, storage, null); // link.sessionId = null
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w1:p1/close", { method: "POST" });
    expect(res.status).toBe(409);
    // Pinned for the same reason as `no_live_pane`: this is the refusal the client must NOT treat as
    // success — the pane is running someone else's session now.
    expect(await res.json()).toMatchObject({ error: { code: "pane_reused" } });
    expect(closed).toEqual([]);
  });

  it("closes a null-sessionId link when the live pane's tab identity matches", async () => {
    const storage = createStorage(tmpDir);
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "w1:p1", sessionId: null, tabId: "w1:t1", workspaceId: "w1" })] };
    const closed: string[] = [];
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage, closePaneFn: (_e, p) => { closed.push(p); return Promise.resolve(); } });
    await seedTaskWithLink(app, storage, null);
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w1:p1/close", { method: "POST" });
    expect(res.status).toBe(200);
    expect(closed).toEqual(["w1:p1"]);
  });
});

describe("GET /api/state — live label preference", () => {
  it("prefers the LIVE herdr tab/workspace labels over the stored ones (so a tab rename shows)", async () => {
    const storage = createStorage(tmpDir);
    // Live row for the seeded pane, but with labels that DIFFER from the stored link (tabLabel "x",
    // workspaceLabel "c" per seedTaskWithLink) — simulating a herdr tab rename after bind time.
    const snapshot: Snapshot = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        env: "work-local", paneId: "w1:p1", status: "working", agent: "claude",
        cwd: "/c", tab: "renamed-live", workspace: "ws-live",
        sessionId: "11111111-2222-3333-4444-555555555555",
        recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
      }],
    };
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage });
    await seedTaskWithLink(app, storage); // stores tabLabel "x" / workspaceLabel "c"
    const state = await (await app.request("/api/state?board=t")).json() as { tasks: { sessions: { tabLabel: string; workspaceLabel: string }[] }[] };
    const link = state.tasks[0]?.sessions[0];
    expect(link?.tabLabel).toBe("renamed-live");
    expect(link?.workspaceLabel).toBe("ws-live");
  });

  it("falls back to the stored label when the session is not live (detached)", async () => {
    const storage = createStorage(tmpDir);
    const app = createApi({ poller, envs: ENVIRONMENTS, storage }); // default poller: sessions: []
    await seedTaskWithLink(app, storage);
    const state = await (await app.request("/api/state?board=t")).json() as { tasks: { sessions: { tabLabel: string }[] }[] };
    expect(state.tasks[0]?.sessions[0]?.tabLabel).toBe("x"); // stored value survives when no live row
  });
});

describe("POST resume", () => {
  const uuid = "11111111-2222-3333-4444-555555555555";

  it("resumes: calls spawn with resumeSessionId and rebinds link keeping sessionId", async () => {
    let seen: unknown;
    const storage = createStorage(tmpDir);
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage,
      spawn: (o) => {
        seen = o;
        return Promise.resolve({ paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", workspaceLabel: "c", tabLabel: "x-a", cwdSnapshot: "/c", idempotent: false });
      },
    });
    await seedTaskWithLink(app, storage);
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w1:p1/resume", { method: "POST" });
    expect(res.status).toBe(200);
    const link = await res.json() as { paneId: string; tabId: string; sessionId: string };
    expect(link.paneId).toBe("w1:p9");
    expect(link.tabId).toBe("w1:t9");
    expect(link.sessionId).toBe(uuid); // kept
    expect((seen as { resumeSessionId?: string }).resumeSessionId).toBe(uuid);
    expect((seen as { targetWorkspaceId?: string }).targetWorkspaceId).toBe("w1");
    expect((seen as { cwd?: string }).cwd).toBe("/c");
    // persisted rebind
    expect(storage.getBoard("t")?.tasks[0]?.sessions[0]?.paneId).toBe("w1:p9");
  });

  it("resumes in the transcript's cwd, not the stored cwdSnapshot", async () => {
    // `claude --resume` is cwd-scoped: it must launch where the session actually ran (per its
    // transcript), not where the herdr pane happened to sit at bind time. seedTaskWithLink stores
    // cwdSnapshot "/c"; the transcript resolver reports the real dir, which must win.
    let seen: unknown;
    const storage = createStorage(tmpDir);
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage,
      sessionCwd: () => Promise.resolve("/real/project/dir"),
      spawn: (o) => {
        seen = o;
        return Promise.resolve({ paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", workspaceLabel: "c", tabLabel: "x-a", cwdSnapshot: "/real/project/dir", idempotent: false });
      },
    });
    await seedTaskWithLink(app, storage);
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w1:p1/resume", { method: "POST" });
    expect(res.status).toBe(200);
    expect((seen as { cwd?: string }).cwd).toBe("/real/project/dir");
  });

  it("calls sessionCwd with the link's sessionId and the resolved env", async () => {
    // Pins the upstream half of the resume→transcript wiring: readSessionCwd needs the session's
    // UUID (not the paneId) and the right env to locate the transcript. A stub that ignored its args
    // would leave a wrong-identifier refactor green.
    let seen: { envId: string; sid: string } | null = null;
    const storage = createStorage(tmpDir);
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage,
      sessionCwd: (env, sid) => { seen = { envId: env.id, sid }; return Promise.resolve("/real/dir"); },
      spawn: () => Promise.resolve({ paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", workspaceLabel: "c", tabLabel: "x-a", cwdSnapshot: "/real/dir", idempotent: false }),
    });
    await seedTaskWithLink(app, storage);
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w1:p1/resume", { method: "POST" });
    expect(res.status).toBe(200);
    expect(seen).toEqual({ envId: "work-local", sid: uuid });
  });

  it("falls back to the stored cwdSnapshot when the transcript cwd is unavailable", async () => {
    let seen: unknown;
    const storage = createStorage(tmpDir);
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage,
      sessionCwd: () => Promise.resolve(null),
      spawn: (o) => {
        seen = o;
        return Promise.resolve({ paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", workspaceLabel: "c", tabLabel: "x-a", cwdSnapshot: "/c", idempotent: false });
      },
    });
    await seedTaskWithLink(app, storage);
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w1:p1/resume", { method: "POST" });
    expect(res.status).toBe(200);
    expect((seen as { cwd?: string }).cwd).toBe("/c");
  });

  it("400s when the link has no sessionId", async () => {
    const storage = createStorage(tmpDir);
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage,
      spawn: () => Promise.reject(new Error("spawn should not be called")),
    });
    await seedTaskWithLink(app, storage, null);
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w1:p1/resume", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("no_session_id");
    const board = storage.getBoard("t");
    expect(board?.tasks[0]?.sessions[0]?.sessionId).toBeNull(); // link untouched
  });

  it("400s when the link's sessionId is not a UUID, and never calls spawn", async () => {
    let called = false;
    const storage = createStorage(tmpDir);
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage,
      spawn: () => { called = true; return Promise.resolve({ paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", workspaceLabel: "c", tabLabel: "x-a", cwdSnapshot: "/c", idempotent: false }); },
    });
    await seedTaskWithLink(app, storage, "$(touch x)");
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w1:p1/resume", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("validation");
    expect(called).toBe(false);
  });

  it("recreates the tab under the link's stored name, and still sends no launch flags", async () => {
    let seen: unknown;
    const storage = createStorage(tmpDir);
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage,
      spawn: (o) => {
        seen = o;
        return Promise.resolve({ paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", workspaceLabel: "c", tabLabel: "x-a", cwdSnapshot: "/c", idempotent: false });
      },
    });
    await seedTaskWithLink(app, storage);
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w1:p1/resume", { method: "POST" });
    expect(res.status).toBe(200);
    expect((seen as { sessionName?: string }).sessionName).toBe("x-a");
    // The flags themselves are spawn.ts's job (test/spawn.test.ts pins that resume sends none); what
    // the route owns is passing the NAME — so the recreated tab is not silently relabelled `<slug>-a`
    // — and passing NO launch-flag option at all. Both are asserted: checking only `model` let the
    // route start sending `remoteControl: true`, silently re-connecting a resumed session to
    // claude.ai, with this test still green.
    expect((seen as { model?: string }).model).toBeUndefined();
    expect((seen as { remoteControl?: boolean }).remoteControl).toBeUndefined();
  });

  // link.name is `""` on legacy links (server/api.ts:118 heals it to the paneId for DISPLAY only —
  // the stored value stays empty). Passing "" through would label the recreated tab with nothing.
  // `link.name` is client-supplied on the attach / from-session routes (`z.string().default("")`), and
  // the MCP bind path puts the session's own `/rename`d name there — so it is NOT a string this route
  // composed. Sanitize, don't drop: the operator's intent survives, and a leading `-` never reaches
  // `herdr tab create` as a flag. Only a name with nothing usable left falls back to `<slug>-a`.
  it.each([
    ["Fix the auth bug", "fix-the-auth-bug"],
    ["My Session", "my-session"],
    ["-rf", "rf"],
    ["--dangerously-skip-permissions", "dangerously-skip-permissions"],
    ["a b; rm -rf /", "a-b-rm-rf"],
    ["my-task-a", "my-task-a"],                       // already valid → unchanged
  ])("sanitizes a stored link name (%j → %j)", async (name, expected) => {
    let seen: unknown;
    const storage = createStorage(tmpDir);
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage,
      spawn: (o) => {
        seen = o;
        return Promise.resolve({ paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", workspaceLabel: "c", tabLabel: "x-a", cwdSnapshot: "/c", idempotent: false });
      },
    });
    await seedTaskWithLink(app, storage);
    await storage.withBoard("t", (b) => {
      if (b === null) return { board: null, result: undefined };
      return {
        board: { ...b, tasks: b.tasks.map((t) => ({ ...t, sessions: t.sessions.map((s) => ({ ...s, name })) })) },
        result: undefined,
      };
    });
    await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w1:p1/resume", { method: "POST" });
    expect((seen as { sessionName?: string }).sessionName).toBe(expected);
  });

  // Nothing usable left → the route derives the name from the card and PASSES it. It used to omit the
  // field so spawn.ts could fill in `<taskSlug>-a` — a second name source the route's fallback chain
  // could not reach, which is why a card titled without Latin characters ("Отладка" here stands for
  // the stored name, but the same held for the title) always resumed as `task-a`. One name source now,
  // in the route. seedTaskWithLink's card is titled "x", so the derived name is `x-a`.
  it.each(["", "***", "Отладка"])("derives the name when the stored one has nothing usable left (%j)", async (name) => {
    let seen: unknown;
    const storage = createStorage(tmpDir);
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage,
      spawn: (o) => {
        seen = o;
        return Promise.resolve({ paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", workspaceLabel: "c", tabLabel: "x-a", cwdSnapshot: "/c", idempotent: false });
      },
    });
    await seedTaskWithLink(app, storage);
    await storage.withBoard("t", (b) => {
      if (b === null) return { board: null, result: undefined };
      return {
        board: { ...b, tasks: b.tasks.map((t) => ({ ...t, sessions: t.sessions.map((s) => ({ ...s, name })) })) },
        result: undefined,
      };
    });
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w1:p1/resume", { method: "POST" });
    expect(res.status).toBe(200);
    expect(seen).toBeDefined();
    expect((seen as { sessionName?: string }).sessionName).toBe("x-a");
  });

});

describe("POST resume — rebinds one link by ?sid and keeps the live sibling intact", () => {
  const OLD = "11111111-2222-3333-4444-555555555555";
  const NEW = "bbbbbbbb-5555-6666-7777-888888888888";

  it("resume?sid=OLD rebinds OLD only; the NEW link is byte-intact and not duplicated", async () => {
    const storage = createStorage(tmpDir);
    // Pane pX now hosts the live NEW session; OLD is detached (absent from the snapshot) but resumable.
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "pX", sessionId: NEW, tabId: "new:t" })] };
    const app = createApi({
      poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage,
      spawn: () => Promise.resolve({ paneId: "pR", tabId: "tR", workspaceId: "w1", workspaceLabel: "c", tabLabel: "x-a", cwdSnapshot: "/c", idempotent: false }),
    });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "T" }) });
    await storage.withBoard("t", (b) => {
      if (b === null) return { board: null, result: undefined };
      const mk = (sid: string, paneId: string, tabId: string) => ({ env: "work-local", paneId, tabId, tabLabel: "x", workspaceId: "w1", workspaceLabel: "c", name: sid, cwdSnapshot: "/c", sessionId: sid });
      const task = { id: "t_aaaaaaa", title: "x", description: "", status: "todo", priority: null, sessions: [mk(OLD, "pX", "old:t"), mk(NEW, "pX", "new:t")], createdAt: 1, updatedAt: 1, log: [] };
      return { board: { ...b, tasks: [task] }, result: undefined };
    });
    const res = await app.request(`/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/pX/resume?sid=${OLD}`, { method: "POST" });
    expect(res.status).toBe(200);
    const sessions = storage.getBoard("t")?.tasks[0]?.sessions ?? [];
    expect(sessions).toHaveLength(2); // no duplicate
    const oldLink = sessions.find((s) => s.sessionId === OLD);
    const newLink = sessions.find((s) => s.sessionId === NEW);
    expect(oldLink?.paneId).toBe("pR"); // OLD rebound to the resumed pane
    expect(newLink?.paneId).toBe("pX"); // NEW untouched
    expect(newLink?.tabId).toBe("new:t"); // NEW byte-intact
  });

  it("is env-scoped: resuming work-local's link leaves a same-uuid personal-local sibling untouched", async () => {
    // A Claude sessionId is unique per env (per CLAUDE_CONFIG_DIR), not globally, so a task can hold two
    // links with the same uuid in different envs. The write-back must rebind only the resumed env's link.
    const storage = createStorage(tmpDir);
    const app = createApi({
      poller: { ...poller, getSnapshot: () => ({ envs: { "work-local": { reachable: true } }, sessions: [] }) }, envs: ENVIRONMENTS, storage,
      spawn: () => Promise.resolve({ paneId: "pR", tabId: "tR", workspaceId: "w1", workspaceLabel: "c", tabLabel: "x-a", cwdSnapshot: "/c", idempotent: false }),
    });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "T" }) });
    await storage.withBoard("t", (b) => {
      if (b === null) return { board: null, result: undefined };
      const mk = (env: string, paneId: string, tabId: string) => ({ env, paneId, tabId, tabLabel: "x", workspaceId: "w1", workspaceLabel: "c", name: env, cwdSnapshot: "/c", sessionId: OLD });
      const task = { id: "t_aaaaaaa", title: "x", description: "", status: "todo", priority: null, sessions: [mk("work-local", "wp", "wt"), mk("personal-local", "gp", "gt")], createdAt: 1, updatedAt: 1, log: [] };
      return { board: { ...b, tasks: [task] }, result: undefined };
    });
    const res = await app.request(`/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/wp/resume?sid=${OLD}`, { method: "POST" });
    expect(res.status).toBe(200);
    const sessions = storage.getBoard("t")?.tasks[0]?.sessions ?? [];
    expect(sessions).toHaveLength(2);
    const personal = sessions.find((s) => s.env === "personal-local");
    expect(personal?.paneId).toBe("gp"); // personal-local sibling untouched despite sharing the uuid
    expect(personal?.sessionId).toBe(OLD);
    const wl = sessions.find((s) => s.env === "work-local");
    expect(wl?.paneId).toBe("pR"); // only work-local's link rebound
  });
});

// #1 — the stable herdr ids (tabId/workspaceId) must be persisted onto the link so close/resume have
// real coordinates, and close must heal a legacy empty-tabId link / a churn-relocated pane by sessionId.
function makeLiveRow(o: { paneId: string; sessionId: string | null; tabId: string; workspaceId?: string; cwd?: string }): SessionRow {
  return {
    env: "work-local", paneId: o.paneId, status: "working", agent: "claude",
    cwd: o.cwd ?? "/c", tab: "t", workspace: "w",
    tabId: o.tabId, workspaceId: o.workspaceId ?? "w1",
    sessionId: o.sessionId, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
  };
}

async function seedLinkOnBoardT(storage: ReturnType<typeof createStorage>, link: { paneId: string; tabId: string; sessionId: string | null; workspaceId?: string }): Promise<void> {
  await storage.withBoard("t", (b) => {
    if (b === null) return { board: null, result: undefined };
    const task = {
      id: "t_aaaaaaa", title: "x", description: "", status: "todo", priority: null,
      sessions: [{ env: "work-local", paneId: link.paneId, tabId: link.tabId, tabLabel: "x", workspaceId: link.workspaceId ?? "w1", workspaceLabel: "c", name: "x-a", cwdSnapshot: "/c", sessionId: link.sessionId }],
      createdAt: 1, updatedAt: 1, log: [],
    };
    return { board: { ...b, tasks: [task] }, result: undefined };
  });
}

describe("attach / from-session — persist stable herdr ids (#1)", () => {
  const S = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("attach persists tabId/workspaceId from the live row (client sends only env+paneId)", async () => {
    const storage = createStorage(tmpDir);
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "w9:p1", sessionId: S, tabId: "w9:t1", workspaceId: "w9" })] };
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage });
    const tid = await createTaskOnTestBoard(app);
    const res = await app.request(`/api/boards/test/tasks/${tid}/attach`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "w9:p1" }),
    });
    expect(res.status).toBe(200);
    const link = storage.getBoard("test")?.tasks[0]?.sessions[0];
    expect(link?.tabId).toBe("w9:t1");
    expect(link?.workspaceId).toBe("w9");
  });

  it("from-session persists tabId/workspaceId/cwd from the live row", async () => {
    const storage = createStorage(tmpDir);
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "fs:p1", sessionId: S, tabId: "fs:t1", workspaceId: "fs:w1", cwd: "/from" })] };
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const res = await app.request("/api/boards/test/tasks/from-session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "From", env: "work-local", paneId: "fs:p1" }),
    });
    expect(res.status).toBe(201);
    const link = storage.getBoard("test")?.tasks[0]?.sessions[0];
    expect(link?.tabId).toBe("fs:t1");
    expect(link?.workspaceId).toBe("fs:w1");
    expect(link?.cwdSnapshot).toBe("/from");
  });
});

describe("POST close — churn-heal + poisoning safety (#1)", () => {
  const S = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const S2 = "99999999-8888-7777-6666-555555555555";

  async function makeCloseApp(storage: ReturnType<typeof createStorage>, snapshot: Snapshot): Promise<{ app: ReturnType<typeof createApi>; closed: string[] }> {
    const closed: string[] = [];
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage, closePaneFn: (_e, paneId) => { closed.push(paneId); return Promise.resolve(); } });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "T" }) });
    return { app, closed };
  }

  it("closes the live pane for a legacy empty-tabId link (same sessionId)", async () => {
    const storage = createStorage(tmpDir);
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "w9:p1", sessionId: S, tabId: "w9:t1" })] };
    const { app, closed } = await makeCloseApp(storage, snapshot);
    await seedLinkOnBoardT(storage, { paneId: "w9:p1", tabId: "", sessionId: S }); // broken: empty tabId
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w9:p1/close", { method: "POST" });
    expect(res.status).toBe(200);
    expect(closed).toEqual(["w9:p1"]); // pane close needs no tabId at all
  });

  it("resolves a churn-relocated pane by sessionId and closes the current pane", async () => {
    const storage = createStorage(tmpDir);
    // Link stored at old:p; herdr restarted → same session now at new:p. buildBoardState heals the
    // served paneId to new:p, so the UI closes via new:p.
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "new:p", sessionId: S, tabId: "new:t" })] };
    const { app, closed } = await makeCloseApp(storage, snapshot);
    await seedLinkOnBoardT(storage, { paneId: "old:p", tabId: "old:t", sessionId: S });
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/new:p/close", { method: "POST" });
    expect(res.status).toBe(200);
    expect(closed).toEqual(["new:p"]);
  });

  it("never closes a stranger's pane when the pane was reused by a different session", async () => {
    const storage = createStorage(tmpDir);
    // Pane w9:p1 now hosts a DIFFERENT session (S2); our link is S. The live row's sessionId disagrees,
    // so close refuses (409) and touches nothing rather than killing the stranger's pane.
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "w9:p1", sessionId: S2, tabId: "stranger:t" })] };
    const { app, closed } = await makeCloseApp(storage, snapshot);
    await seedLinkOnBoardT(storage, { paneId: "w9:p1", tabId: "", sessionId: S });
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/w9:p1/close", { method: "POST" });
    expect(res.status).toBe(409);
    expect(closed).toEqual([]); // stranger's pane never closed
  });
});

describe("POST detach — churn-heal (#1)", () => {
  const S = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  it("unlinks a churn-relocated session addressed by its healed (new) paneId", async () => {
    const storage = createStorage(tmpDir);
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "new:p", sessionId: S, tabId: "new:t" })] };
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "T" }) });
    await seedLinkOnBoardT(storage, { paneId: "old:p", tabId: "old:t", sessionId: S });
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/detach", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "new:p" }),
    });
    expect(res.status).toBe(200);
    expect(storage.getBoard("t")?.tasks[0]?.sessions).toHaveLength(0); // link removed despite paneId churn
  });
});

describe("POST detach — targets one of two same-pane links by sessionId", () => {
  const OLD = "aaaaaaaa-1111-2222-3333-444444444444";
  const NEW = "bbbbbbbb-5555-6666-7777-888888888888";

  it("removes only the sessionId-matched link, leaving the sibling", async () => {
    const storage = createStorage(tmpDir);
    const app = createApi({ poller, envs: ENVIRONMENTS, storage });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "T" }) });
    await storage.withBoard("t", (b) => {
      if (b === null) return { board: null, result: undefined };
      const s = (sid: string, name: string) => ({ env: "work-local", paneId: "pX", tabId: "t", tabLabel: "x", workspaceId: "w", workspaceLabel: "c", name, cwdSnapshot: "/c", sessionId: sid });
      const task = { id: "t_aaaaaaa", title: "x", description: "", status: "todo", priority: null, sessions: [s(OLD, "old"), s(NEW, "new")], createdAt: 1, updatedAt: 1, log: [] };
      return { board: { ...b, tasks: [task] }, result: undefined };
    });
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/detach", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "pX", sessionId: OLD }),
    });
    expect(res.status).toBe(200);
    const links = storage.getBoard("t")?.tasks[0]?.sessions ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]?.sessionId).toBe(NEW);
  });
});

describe("POST close — targets one of two same-pane links by ?sid", () => {
  const OLD = "aaaaaaaa-1111-2222-3333-444444444444";
  const NEW = "bbbbbbbb-5555-6666-7777-888888888888";

  async function seedTwo(storage: ReturnType<typeof createStorage>): Promise<void> {
    await storage.withBoard("t", (b) => {
      if (b === null) return { board: null, result: undefined };
      const s = (sid: string, tabId: string) => ({ env: "work-local", paneId: "pX", tabId, tabLabel: "x", workspaceId: "w", workspaceLabel: "c", name: sid, cwdSnapshot: "/c", sessionId: sid });
      const task = { id: "t_aaaaaaa", title: "x", description: "", status: "todo", priority: null, sessions: [s(OLD, "old:t"), s(NEW, "new:t")], createdAt: 1, updatedAt: 1, log: [] };
      return { board: { ...b, tasks: [task] }, result: undefined };
    });
  }

  it("closes the ?sid-matched link's pane (the live one)", async () => {
    const closed: string[] = [];
    const storage = createStorage(tmpDir);
    // Live row confirms NEW at pX; ?sid=NEW resolves our link and the pane is closed once.
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "pX", sessionId: NEW, tabId: "new:t" })] };
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage, closePaneFn: (_e, paneId) => { closed.push(paneId); return Promise.resolve(); } });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "T" }) });
    await seedTwo(storage);
    const res = await app.request(`/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/pX/close?sid=${NEW}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(closed).toEqual(["pX"]);
  });

  it("400s a malformed ?sid", async () => {
    const storage = createStorage(tmpDir);
    const app = createApi({ poller, envs: ENVIRONMENTS, storage, closePaneFn: () => Promise.resolve() });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "T" }) });
    await seedTwo(storage);
    const res = await app.request("/api/boards/t/tasks/t_aaaaaaa/sessions/work-local/pX/close?sid=not-a-uuid", { method: "POST" });
    expect(res.status).toBe(400);
  });
});

describe("Host-header guard middleware (#2 — anti-DNS-rebinding)", () => {
  it("403s a present non-loopback Host; allows loopback and an absent Host", async () => {
    const app = makeApi(tmpDir);
    expect((await app.request("/api/health", { headers: { host: "evil.com" } })).status).toBe(403);
    expect((await app.request("/api/health", { headers: { host: "127.0.0.1:8787" } })).status).toBe(200);
    // No Host header → not a browser → not a rebinding vector → allowed (local CLI clients).
    expect((await app.request("/api/health")).status).toBe(200);
  });
});

describe("GET /read — throttle cache (#4)", () => {
  it("coalesces repeat reads within the TTL into a single herdr call", async () => {
    let calls = 0;
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
      read: () => { calls += 1; return Promise.resolve({ text: "hi", ctxPct: null, model: null, sessionName: null }); },
    });
    const r1 = await app.request("/api/sessions/work-local/w1:p1/read");
    expect(r1.status).toBe(200);
    await app.request("/api/sessions/work-local/w1:p1/read"); // within the 1s TTL → served from cache
    expect(calls).toBe(1);
  });

  it("does not cache a failed (502) read — errors always re-hit herdr", async () => {
    let calls = 0;
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
      read: () => { calls += 1; return Promise.reject(new Error("unreachable")); },
    });
    expect((await app.request("/api/sessions/work-local/w1:p1/read")).status).toBe(502);
    expect((await app.request("/api/sessions/work-local/w1:p1/read")).status).toBe(502);
    expect(calls).toBe(2);
  });

  it("keys by live sessionId so a churned (reused) pane can't serve the prior session's cached text", async () => {
    let snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "w1:p1", sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", tabId: "t" })] };
    let n = 0;
    const app = createApi({
      poller: { ...poller, getSnapshot: () => snapshot },
      envs: ENVIRONMENTS, storage: createStorage(tmpDir),
      read: () => { n += 1; return Promise.resolve({ text: `read-${String(n)}`, ctxPct: null, model: null, sessionName: null }); },
    });
    const r1 = await (await app.request("/api/sessions/work-local/w1:p1/read")).json() as { text: string };
    expect(r1.text).toBe("read-1");
    // herdr churn: the same paneId now hosts a DIFFERENT session
    snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "w1:p1", sessionId: "99999999-8888-7777-6666-555555555555", tabId: "t" })] };
    const r2 = await (await app.request("/api/sessions/work-local/w1:p1/read")).json() as { text: string };
    expect(r2.text).toBe("read-2"); // fresh read, not the cached "read-1"
  });
});

describe("POST spawn — timeout cleanup (#5)", () => {
  function pendingSpawn(): { promise: Promise<SpawnResult>; resolve: (r: SpawnResult) => void } {
    let resolve: ((r: SpawnResult) => void) | undefined;
    const promise = new Promise<SpawnResult>((res) => { resolve = res; });
    if (resolve === undefined) throw new Error("unreachable"); // executor runs synchronously
    return { promise, resolve };
  }
  async function taskOnBoard(app: ReturnType<typeof createApi>): Promise<string> {
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const { id } = await (await app.request("/api/boards/test/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T", status: "todo" }) })).json() as { id: string };
    return id;
  }
  const doneResult = (tabId: string, idempotent: boolean): SpawnResult => ({
    paneId: "w1:p2", tabId, workspaceId: "w1", workspaceLabel: "c", tabLabel: "t-a", cwdSnapshot: "/c", idempotent,
  });

  it("tears down the orphaned session an abandoned (timed-out) spawn later creates", async () => {
    const closed: string[] = [];
    const { promise, resolve } = pendingSpawn();
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
      spawn: () => promise, closePaneFn: (_e, paneId) => { closed.push(paneId); return Promise.resolve(); },
      spawnTimeoutMs: 10,
    });
    const id = await taskOnBoard(app);
    const res = await app.request(`/api/boards/test/tasks/${id}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral" }),
    });
    expect(res.status).toBe(500);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("spawn_timeout");
    resolve(doneResult("orphan:t", false)); // the abandoned spawn finishes → its pane must be closed
    await vi.waitFor(() => { expect(closed).toEqual(["w1:p2"]); }); // doneResult paneId (pane close cascades the fresh workspace)
  });

  it("does NOT close the pane when the timed-out spawn was an idempotent rejoin (pre-existing session)", async () => {
    const closed: string[] = [];
    const { promise, resolve } = pendingSpawn();
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
      spawn: () => promise, closePaneFn: (_e, paneId) => { closed.push(paneId); return Promise.resolve(); },
      spawnTimeoutMs: 10,
    });
    const id = await taskOnBoard(app);
    const res = await app.request(`/api/boards/test/tasks/${id}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ env: "work-local", targetWorkspaceId: null, repo: "corral" }),
    });
    expect(res.status).toBe(500);
    resolve(doneResult("rejoin:t", true));
    await new Promise((r) => setTimeout(r, 30)); // let the background handler run; it must close nothing
    expect(closed).toEqual([]);
  });
});

describe("POST from-session — UUID-aware claim-check", () => {
  const OLD = "aaaaaaaa-1111-2222-3333-444444444444";
  const NEW = "bbbbbbbb-5555-6666-7777-888888888888";

  it("201s for a restarted session whose pane is held by a stale (dead-UUID) link", async () => {
    const storage = createStorage(tmpDir);
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "pX", sessionId: NEW, tabId: "tX" })] };
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    await storage.withBoard("test", (b) => {
      if (b === null) return { board: null, result: undefined };
      const task = { id: "t_stale00", title: "T", description: "", status: "todo", priority: null,
        sessions: [{ env: "work-local", paneId: "pX", tabId: "old", tabLabel: "x", workspaceId: "w", workspaceLabel: "c", name: "x", cwdSnapshot: "/c", sessionId: OLD }],
        createdAt: 1, updatedAt: 1, log: [] };
      return { board: { ...b, tasks: [task] }, result: undefined };
    });
    const res = await app.request("/api/boards/test/tasks/from-session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New", env: "work-local", paneId: "pX" }),
    });
    expect(res.status).toBe(201);
    const created = await res.json() as { sessions: { sessionId: string | null }[] };
    expect(created.sessions[0]?.sessionId).toBe(NEW);
  });

  it("201s during the /new window when the live row's sessionId is momentarily null", async () => {
    const storage = createStorage(tmpDir);
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "pX", sessionId: null, tabId: "tX" })] };
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    await storage.withBoard("test", (b) => {
      if (b === null) return { board: null, result: undefined };
      const task = { id: "t_nul0000", title: "T", description: "", status: "todo", priority: null,
        sessions: [{ env: "work-local", paneId: "pX", tabId: "old", tabLabel: "x", workspaceId: "w", workspaceLabel: "c", name: "x", cwdSnapshot: "/c", sessionId: OLD }],
        createdAt: 1, updatedAt: 1, log: [] };
      return { board: { ...b, tasks: [task] }, result: undefined };
    });
    const res = await app.request("/api/boards/test/tasks/from-session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New", env: "work-local", paneId: "pX" }),
    });
    expect(res.status).toBe(201);
  });

  it("still 409s a genuine double-assign of the same live UUID", async () => {
    const storage = createStorage(tmpDir);
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "pX", sessionId: NEW, tabId: "tX" })] };
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const first = await app.request("/api/boards/test/tasks/from-session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "One", env: "work-local", paneId: "pX" }),
    });
    expect(first.status).toBe(201);
    const second = await app.request("/api/boards/test/tasks/from-session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Two", env: "work-local", paneId: "pX" }),
    });
    expect(second.status).toBe(409);
  });
});

describe("POST attach — UUID-aware idempotency (two same-pane cards)", () => {
  const OLD = "aaaaaaaa-1111-2222-3333-444444444444";
  const NEW = "bbbbbbbb-5555-6666-7777-888888888888";

  it("appends the restarted session alongside the stale link, and drops it from Unassigned", async () => {
    const storage = createStorage(tmpDir);
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "pX", sessionId: NEW, tabId: "tX" })] };
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    await storage.withBoard("test", (b) => {
      if (b === null) return { board: null, result: undefined };
      const task = { id: "t_two0000", title: "T", description: "", status: "todo", priority: null,
        sessions: [{ env: "work-local", paneId: "pX", tabId: "old", tabLabel: "x", workspaceId: "w", workspaceLabel: "c", name: "wm-a", cwdSnapshot: "/c", sessionId: OLD }],
        createdAt: 1, updatedAt: 1, log: [] };
      return { board: { ...b, tasks: [task] }, result: undefined };
    });
    const res = await app.request("/api/boards/test/tasks/t_two0000/attach", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "pX" }),
    });
    expect(res.status).toBe(200);
    const links = storage.getBoard("test")?.tasks[0]?.sessions ?? [];
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.sessionId).sort()).toEqual([OLD, NEW].sort());
    const state = await (await app.request("/api/state?board=test")).json() as { unassigned: { sessionId: string | null }[] };
    expect(state.unassigned.some((s) => s.sessionId === NEW)).toBe(false);
  });

  it("stays idempotent for the same live session (no duplicate)", async () => {
    const storage = createStorage(tmpDir);
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "pX", sessionId: NEW, tabId: "tX" })] };
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage });
    const tid = await createTaskOnTestBoard(app);
    const body = JSON.stringify({ env: "work-local", paneId: "pX" });
    await app.request(`/api/boards/test/tasks/${tid}/attach`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const res2 = await app.request(`/api/boards/test/tasks/${tid}/attach`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect(res2.status).toBe(200);
    expect(storage.getBoard("test")?.tasks.find((t) => t.id === tid)?.sessions).toHaveLength(1);
  });

  it("a null-UUID pane-mate suppresses the append (legacy pane bind, matches buildUnassigned)", async () => {
    const storage = createStorage(tmpDir);
    const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [makeLiveRow({ paneId: "pX", sessionId: NEW, tabId: "tX" })] };
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    await storage.withBoard("test", (b) => {
      if (b === null) return { board: null, result: undefined };
      const task = { id: "t_leg0000", title: "T", description: "", status: "todo", priority: null,
        sessions: [{ env: "work-local", paneId: "pX", tabId: "", tabLabel: "x", workspaceId: "w", workspaceLabel: "c", name: "legacy", cwdSnapshot: "/c", sessionId: null }],
        createdAt: 1, updatedAt: 1, log: [] };
      return { board: { ...b, tasks: [task] }, result: undefined };
    });
    const res = await app.request("/api/boards/test/tasks/t_leg0000/attach", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "pX" }),
    });
    expect(res.status).toBe(200);
    expect(storage.getBoard("test")?.tasks[0]?.sessions).toHaveLength(1); // null-UUID pane-mate claims the pane → no duplicate
  });
});

// The closed-projection trap: LiveSessionDataSchema is a closed field list built field-by-field in
// server/api.ts, so a new SessionRow field that is not added in BOTH places never reaches the web —
// and the omission is silent. This is the test that catches it.
describe("GET /api/state — Claude's own session state reaches the board", () => {
  it("projects claudeStatus, waitingFor, remoteControl, registryStatus and claudeName onto the enriched link", async () => {
    const storage = createStorage(tmpDir);
    const snapshot: Snapshot = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        ...makeLiveRow({ paneId: "w1:p1", sessionId: "11111111-2222-3333-4444-555555555555", tabId: "w1:t1" }),
        claudeStatus: "waiting", waitingFor: "input needed", registryStatus: "ok", remoteControl: true,
        // Ungated on purpose: this is the session modal's subtitle, which reports what Claude calls the
        // session whoever set that name. The GATED value is the link's `name`, resolved separately.
        claudeName: "auto-derived-title", claudeNameUserSet: false,
      }],
    };
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage });
    await seedTaskWithLink(app, storage);
    const state = await (await app.request("/api/state?board=t")).json() as {
      tasks: { sessions: { live: { claudeStatus: string; waitingFor: string; remoteControl: boolean; registryStatus: string; claudeName: string | null } | null }[] }[];
    };
    const live = state.tasks[0]?.sessions[0]?.live;
    expect(live?.claudeName).toBe("auto-derived-title");
    expect(live?.claudeStatus).toBe("waiting");
    expect(live?.waitingFor).toBe("input needed");
    expect(live?.remoteControl).toBe(true);
    expect(live?.registryStatus).toBe("ok");
  });

  // remoteControl: false must survive the projection as false. If the enrichment ever passed it
  // through something falsy-collapsing, a disconnected session would be indistinguishable from one
  // corral has no record for — which is the whole point of the tri-state.
  it("projects remoteControl: false distinctly from a missing record", async () => {
    const storage = createStorage(tmpDir);
    const snapshot: Snapshot = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        ...makeLiveRow({ paneId: "w1:p1", sessionId: "11111111-2222-3333-4444-555555555555", tabId: "w1:t1" }),
        claudeStatus: "idle", remoteControl: false, registryStatus: "ok", claudeName: null, claudeNameUserSet: null,
      }],
    };
    const app = createApi({ poller: { ...poller, getSnapshot: () => snapshot }, envs: ENVIRONMENTS, storage });
    await seedTaskWithLink(app, storage);
    const state = await (await app.request("/api/state?board=t")).json() as {
      tasks: { sessions: { live: { remoteControl: boolean | null } | null }[] }[];
    };
    expect(state.tasks[0]?.sessions[0]?.live?.remoteControl).toBe(false);
  });

  it("gives a detached link null state, never a stale one", async () => {
    const storage = createStorage(tmpDir);
    const app = createApi({ poller, envs: ENVIRONMENTS, storage }); // no live rows
    await seedTaskWithLink(app, storage);
    const state = await (await app.request("/api/state?board=t")).json() as {
      tasks: { sessions: { live: { claudeStatus: string | null; waitingFor: string | null; remoteControl: boolean | null; registryStatus: string | null } | null }[] }[];
    };
    const live = state.tasks[0]?.sessions[0]?.live;
    expect(live?.claudeStatus).toBeNull();
    expect(live?.waitingFor).toBeNull();
    expect(live?.remoteControl).toBeNull();
    expect(live?.registryStatus).toBeNull();
  });
});

// §1's whole table, asserted at the route rather than through the picker: the browser always sends
// `targetWorkspaceId` explicitly, the MCP tool omits the key, and those are DIFFERENT requests.
describe("POST /api/boards/:bid/tasks/:tid/spawn — the three-state target", () => {
  async function seed(app: ReturnType<typeof createApi>): Promise<string> {
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const { id } = await (await app.request("/api/boards/test/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "My Task", status: "todo" }) })).json() as { id: string };
    return id;
  }
  async function spawnWith(body: Record<string, unknown>): Promise<{ res: Response; opts: Record<string, unknown> | undefined }> {
    const { app, spawn } = makeApiWithSpawn(tmpDir);
    const tid = await seed(app);
    const res = await app.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const first: unknown = spawn.mock.calls[0]?.[0];
    return { res, opts: typeof first === "object" && first !== null ? { ...first } : undefined };
  }

  it("a workspace id joins that workspace", async () => {
    const { res, opts } = await spawnWith({ env: "work-local", targetWorkspaceId: "w1" });
    expect(res.status).toBe(200);
    expect(opts?.targetWorkspaceId).toBe("w1");
  });

  // The browser's "＋ <repo>" pick. It stays a CREATE even when a space with that label exists —
  // which is exactly the case resolve-by-repo would join instead.
  it("an explicit null with a repo creates a new space", async () => {
    const { res, opts } = await spawnWith({ env: "work-local", targetWorkspaceId: null, repo: "corral" });
    expect(res.status).toBe(200);
    expect(opts?.targetWorkspaceId).toBeNull();
    expect(opts?.repo).toBe("corral");
  });

  it("an absent key with a repo passes the target through absent, for resolve-by-repo", async () => {
    const { res, opts } = await spawnWith({ env: "work-local", repo: "corral" });
    expect(res.status).toBe(200);
    expect(opts).toBeDefined();
    expect(Object.hasOwn(opts ?? {}, "targetWorkspaceId")).toBe(false);
    expect(opts?.repoPath).toBe("/repos/corral");
  });

  it("no target and no repo is refused, and nothing is spawned", async () => {
    const { res, opts } = await spawnWith({ env: "work-local" });
    expect(res.status).toBe(400);
    expect(opts).toBeUndefined();
  });
});

// The card used to carry the repo, and the spawn route used to fall back to it. Posting `repo` on a
// card is now silently stripped by z.object, so this asserts the CONSEQUENCE rather than the key's
// absence — a test that only checked the stored shape would still pass if the fallback came back.
describe("a card no longer supplies the spawn target", () => {
  it("stores no repo from a create body, and a later spawn with no target is refused", async () => {
    const { app, spawn } = makeApiWithSpawn(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const created = await (await app.request("/api/boards/test/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "My Task", status: "todo", repo: "corral" }),
    })).json() as { id: string } & Record<string, unknown>;
    expect(Object.hasOwn(created, "repo")).toBe(false);
    const res = await app.request(`/api/boards/test/tasks/${created.id}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local" }),
    });
    expect(res.status).toBe(400);
    expect(spawn.mock.calls).toHaveLength(0);
  });
});

describe("POST /api/boards/:bid/tasks/:tid/spawn — unknown_repo", () => {
  async function spawnWith(body: Record<string, unknown>): Promise<{ res: Response; spawned: boolean }> {
    const { app, spawn } = makeApiWithSpawn(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const { id } = await (await app.request("/api/boards/test/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "My Task", status: "todo" }) })).json() as { id: string };
    const res = await app.request(`/api/boards/test/tasks/${id}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { res, spawned: spawn.mock.calls.length > 0 };
  }

  // Its own code, not the blanket `validation`: the MCP tool re-renders THIS case as "repository not
  // configured — retry with one of…", and keying that on `validation` would answer the same for a
  // bad model id.
  it("400s with unknown_repo for a repo that is not configured, before any spawn work", async () => {
    const { res, spawned } = await spawnWith({ env: "work-local", repo: "not-configured" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("unknown_repo");
    expect(spawned).toBe(false);
  });

  it("a different bad field still returns validation, not unknown_repo", async () => {
    const { res } = await spawnWith({ env: "work-local", targetWorkspaceId: null, repo: "corral", model: "bad model!" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("validation");
  });

  it("an unknown env still returns validation, not unknown_repo", async () => {
    const { res } = await spawnWith({ env: "nope", repo: "corral" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("validation");
  });

  // A key like "__proto__" resolves to an inherited value on a plain index — Object.hasOwn is what
  // keeps a client string from becoming a path.
  it("400s on a prototype key rather than resolving an inherited value", async () => {
    const { res, spawned } = await spawnWith({ env: "work-local", repo: "__proto__" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("unknown_repo");
    expect(spawned).toBe(false);
  });
});

// The idempotency scan compares this set against sessions listed from the TARGET environment only
// (server/spawn.ts), so a pane id from another environment must not appear in it. Two local
// environments are two independent herdr servers, each numbering panes from scratch — `w1:p1` exists
// in both — and a collision would make a retry start a second session instead of rejoining the first.
describe("POST /api/boards/:bid/tasks/:tid/spawn — assigned panes are scoped to the target env", () => {
  it("excludes a same-id pane that belongs to a different environment", async () => {
    const { app, spawn } = makeApiWithSpawn(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const { id } = await (await app.request("/api/boards/test/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "My Task", status: "todo" }) })).json() as { id: string };
    const storage = createStorage(tmpDir);
    await storage.withBoard("test", (b) => {
      if (b === null) return { board: null, result: undefined };
      const link = (env: string, paneId: string, name: string) => ({ env, paneId, tabId: "", tabLabel: "", workspaceId: "", workspaceLabel: "", name, cwdSnapshot: "", sessionId: null });
      return {
        board: { ...b, tasks: b.tasks.map((t) => t.id === id ? { ...t, sessions: [link("personal-local", "w7:p1", "other-a"), link("work-local", "w9:p9", "mine-a")] } : t) },
        result: undefined,
      };
    });
    const res = await app.request(`/api/boards/test/tasks/${id}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: "w1" }),
    });
    expect(res.status).toBe(200);
    const call = spawn.mock.calls[0]?.[0] as { assignedPaneIds: ReadonlySet<string> };
    expect(call.assignedPaneIds.has("w7:p1")).toBe(false); // personal-local's pane
    expect(call.assignedPaneIds.has("w9:p9")).toBe(true);  // work-local's own
  });
});

// §1's table makes `repo` REQUIRED on the explicit-null row. Without this the request reached
// spawnSession with no path and came back as a 500 spawn_error — a contract error reported as a
// server fault.
describe("POST /api/boards/:bid/tasks/:tid/spawn — explicit null needs a repo", () => {
  it("400s on an explicit null target with no repo, instead of failing inside the spawner", async () => {
    const { app, spawn } = makeApiWithSpawn(tmpDir);
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const { id } = await (await app.request("/api/boards/test/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "My Task", status: "todo" }) })).json() as { id: string };
    const res = await app.request(`/api/boards/test/tasks/${id}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", targetWorkspaceId: null }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("validation");
    expect(spawn.mock.calls).toHaveLength(0);
  });
});

describe("landing column when position 0 is closed", () => {
  // Board shape used by every case below: a closed column FIRST, an open one second.
  //
  // The open column is "backlog", NOT "todo", and that is load-bearing. `FromSessionBodySchema`
  // currently defaults status to the literal string "todo"; if this board also had a column with
  // that id, the from-session case would assert "todo" and pass identically before and after the
  // fix — a green test pinning nothing at exactly the site the spec calls out as the fifth and only
  // hardcoded one. Naming the open column anything else is what makes the test go red.
  const closedFirst = [
    { id: "done", label: "Done", type: "closed" },
    { id: "backlog", label: "Backlog", type: "to-do" },
  ];

  async function boardWithClosedFirst(app: ReturnType<typeof makeApi>, id: string): Promise<void> {
    await app.request("/api/boards", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: id }),
    });
    await app.request(`/api/boards/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns: closedFirst }),
    });
  }

  it("reassigns tasks of a deleted column to the first NON-closed column", async () => {
    const app = makeApi(tmpDir);
    await boardWithClosedFirst(app, "b1");
    await app.request("/api/boards/b1", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns: [...closedFirst, { id: "wip", label: "WIP" }] }),
    });
    const created = await (await app.request("/api/boards/b1/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Doomed", status: "wip" }),
    })).json() as { id: string };
    // Delete the "wip" column by PATCHing a column list without it.
    await app.request("/api/boards/b1", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns: closedFirst }),
    });
    const board = await (await app.request("/api/boards/b1")).json() as { tasks: { id: string; status: string }[] };
    expect(board.tasks.find((t) => t.id === created.id)?.status).toBe("backlog");
  });

  it("lands a task moved in from another board in the first non-closed column", async () => {
    const app = makeApi(tmpDir);
    await boardWithClosedFirst(app, "target");
    await app.request("/api/boards", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "source" }),
    });
    const created = await (await app.request("/api/boards/source/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Traveller", status: "blocked" }),
    })).json() as { id: string };
    const res = await app.request(`/api/boards/source/tasks/${created.id}/move`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toBoardId: "target" }),
    });
    expect(res.status).toBe(200);
    const board = await (await app.request("/api/boards/target")).json() as { tasks: { status: string }[] };
    expect(board.tasks[0]?.status).toBe("backlog");
  });

  it("lands a card created from an unassigned session in the first non-closed column", async () => {
    const app = makeApi(tmpDir);
    await boardWithClosedFirst(app, "b2");
    const res = await app.request("/api/boards/b2/tasks/from-session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "From a live session", env: "work-local", paneId: "w1:p1" }),
    });
    expect(res.status).toBe(201);
    const task = await res.json() as { status: string };
    // Red before the fix: the route defaults to the literal "todo", which is not a column here.
    expect(task.status).toBe("backlog");
  });

  it("from-session still honors an explicit status", async () => {
    const app = makeApi(tmpDir);
    await boardWithClosedFirst(app, "b3");
    const res = await app.request("/api/boards/b3/tasks/from-session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Explicit", status: "done", env: "work-local", paneId: "w1:p2" }),
    });
    const task = await res.json() as { status: string };
    expect(task.status).toBe("done");
  });

  it("lands a plain task created with no status in the first non-closed column", async () => {
    const app = makeApi(tmpDir);
    await boardWithClosedFirst(app, "b4");
    const res = await app.request("/api/boards/b4/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No status, plain create" }),
    });
    expect(res.status).toBe(201);
    const task = await res.json() as { status: string };
    expect(task.status).toBe("backlog");
  });

  it("plain task create still honors an explicit status", async () => {
    const app = makeApi(tmpDir);
    await boardWithClosedFirst(app, "b5");
    const res = await app.request("/api/boards/b5/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Explicit plain create", status: "done" }),
    });
    expect(res.status).toBe(201);
    const task = await res.json() as { status: string };
    expect(task.status).toBe("done");
  });
});

it("preserves column order across a PATCH round-trip", async () => {
  const app = makeApi(tmpDir);
  await app.request("/api/boards", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Ordered" }),
  });
  const reordered = [
    { id: "doing", label: "Doing", type: "in-progress" },
    { id: "todo", label: "Todo", type: "to-do" },
    { id: "done", label: "Done", type: "closed" },
  ];
  await app.request("/api/boards/ordered", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columns: reordered }),
  });
  const board = await (await app.request("/api/boards/ordered")).json() as { columns: { id: string }[] };
  expect(board.columns.map((c) => c.id)).toEqual(["doing", "todo", "done"]);
});

describe("PATCH /api/boards/:bid — start-command presets", () => {
  async function makeBoard(app: ReturnType<typeof makeApi>): Promise<void> {
    await app.request("/api/boards", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Presets" }),
    });
  }
  function patch(app: ReturnType<typeof makeApi>, body: unknown): Promise<Response> {
    return Promise.resolve(app.request("/api/boards/presets", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
  }

  it("persists presets and the default id", async () => {
    const app = makeApi(tmpDir);
    await makeBoard(app);
    const res = await patch(app, {
      spawnPresets: [{ id: "p1", text: "/plan" }, { id: "p2", text: "Read the card first." }],
      defaultSpawnPresetId: "p1",
    });
    expect(res.status).toBe(200);
    const board = await (await app.request("/api/boards/presets")).json() as {
      spawnPresets: { id: string; text: string }[]; defaultSpawnPresetId: string | null;
    };
    expect(board.spawnPresets.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(board.defaultSpawnPresetId).toBe("p1");
  });

  it("rejects a preset beginning with a dash — it would reach claude as a flag", async () => {
    const app = makeApi(tmpDir);
    await makeBoard(app);
    expect((await patch(app, { spawnPresets: [{ id: "p1", text: "--continue" }] })).status).toBe(400);
  });

  // The whitelist is narrower than the flag hazard it is named for, so it refuses plenty of text that
  // is nothing like a flag. That is the accepted trade, and it is pinned here BECAUSE it surprises:
  // without this, the next reader meets the refusal as a bug report and widens the rule by accident.
  it("also refuses openings that are no flag at all — non-Latin, '#', '@' — and says what IS accepted", async () => {
    const app = makeApi(tmpDir);
    await makeBoard(app);
    for (const text of ["Продолжи работу", "「開始」", "#tag first", "@docs/spec.md review"]) {
      expect((await patch(app, { spawnPresets: [{ id: "p1", text }] })).status).toBe(400);
    }
    const res = await patch(app, { spawnPresets: [{ id: "p1", text: "Продолжи работу" }] });
    const body = await res.json() as { error: { message: string } };
    // The refusal names the accepted format. (PATCH passes Zod's own message through, so the quotes
    // around "/" arrive JSON-escaped — match the part that carries the meaning.)
    expect(body.error.message).toContain("or an ASCII letter or digit");
    // Prefixing with a slash command is the way through — the rule is about the FIRST character only.
    expect((await patch(app, { spawnPresets: [{ id: "p1", text: "/plan Продолжи работу" }] })).status).toBe(200);
  });

  it("rejects blank, over-long, over-count and duplicate-id preset lists", async () => {
    const app = makeApi(tmpDir);
    await makeBoard(app);
    expect((await patch(app, { spawnPresets: [{ id: "p1", text: "   " }] })).status).toBe(400);
    expect((await patch(app, { spawnPresets: [{ id: "p1", text: `/${"x".repeat(2000)}` }] })).status).toBe(400);
    expect((await patch(app, {
      spawnPresets: Array.from({ length: 21 }, (_, i) => ({ id: `p${String(i)}`, text: "/plan" })),
    })).status).toBe(400);
    expect((await patch(app, {
      spawnPresets: [{ id: "dup", text: "/plan" }, { id: "dup", text: "/review" }],
    })).status).toBe(400);
  });

  it("resolves a defaultSpawnPresetId matching no preset to no default", async () => {
    const app = makeApi(tmpDir);
    await makeBoard(app);
    await patch(app, { spawnPresets: [{ id: "p1", text: "/plan" }], defaultSpawnPresetId: "gone" });
    const board = await (await app.request("/api/boards/presets")).json() as { defaultSpawnPresetId: string | null };
    expect(board.defaultSpawnPresetId).toBeNull();
  });

  it("keeps a preset the default when only its text is edited", async () => {
    const app = makeApi(tmpDir);
    await makeBoard(app);
    await patch(app, { spawnPresets: [{ id: "p1", text: "/plan" }], defaultSpawnPresetId: "p1" });
    await patch(app, { spawnPresets: [{ id: "p1", text: "/plan the migration" }] });
    const board = await (await app.request("/api/boards/presets")).json() as {
      spawnPresets: { text: string }[]; defaultSpawnPresetId: string | null;
    };
    expect(board.spawnPresets[0]?.text).toBe("/plan the migration");
    expect(board.defaultSpawnPresetId).toBe("p1");
  });

  it("drops a default left dangling by a later patch that never mentions it", async () => {
    const app = makeApi(tmpDir);
    await makeBoard(app);
    await patch(app, {
      spawnPresets: [{ id: "p1", text: "/plan" }, { id: "p2", text: "/review" }],
      defaultSpawnPresetId: "p2",
    });
    // No defaultSpawnPresetId key at all — the stored "p2" would otherwise dangle once p2 is dropped.
    await patch(app, { spawnPresets: [{ id: "p1", text: "/plan" }] });
    const board = await (await app.request("/api/boards/presets")).json() as { defaultSpawnPresetId: string | null };
    expect(board.defaultSpawnPresetId).toBeNull();
  });
});
