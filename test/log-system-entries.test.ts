import type { Board, LogEntry } from "@shared/board-schema.ts";
import { BoardSchema } from "@shared/board-schema.ts";
import type { SessionRow, Snapshot } from "@shared/schema";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ENVIRONMENTS } from "../environments.ts";
import { createApi, type SpawnFn } from "../server/api.ts";
import type { Poller } from "../server/poller.ts";
import { createStorage } from "../server/storage.ts";

const SID = "11111111-2222-3333-4444-555555555555";

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    env: "work-local", paneId: "w1:p1", status: "working", agent: "claude", cwd: "/repo",
    tab: "t", workspace: "w", tabId: "tab1", workspaceId: "ws1", sessionId: SID,
    recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null,
    statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null,
    registryStatus: null, claudeName: null, claudeNameUserSet: null, ...over,
  };
}

function link(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    env: "work-local", paneId: "w1:p1", tabId: "tab1", tabLabel: "t", workspaceId: "ws1",
    workspaceLabel: "w", name: "worker-a", cwdSnapshot: "/repo", sessionId: SID, ...over,
  };
}

function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "t_aaaaaaa", title: "T", description: "the task", status: "todo", priority: null,
    createdAt: 1, updatedAt: 2, log: [], sessions: [], ...over,
  };
}

function board(tasks: Record<string, unknown>[], id = "b"): Board {
  const raw = {
    id, label: id.toUpperCase(),
    columns: [{ id: "todo", label: "Todo" }, { id: "doing", label: "Doing" }, { id: "done", label: "Done", type: "closed" }],
    tasks, spawnPresets: [], defaultSpawnPresetId: null,
  };
  return BoardSchema.parse(raw);
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "corral-sys-log-")); });

function makeApi(boards: Board[], sessions: readonly SessionRow[], extra: { spawn?: SpawnFn; closePaneFn?: () => Promise<void> } = {}): {
  readonly app: ReturnType<typeof createApi>;
  readonly storage: ReturnType<typeof createStorage>;
} {
  mkdirSync(path.join(dir, "boards"), { recursive: true });
  for (const b of boards) writeFileSync(path.join(dir, "boards", `${b.id}.json`), JSON.stringify(b));
  const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [...sessions] };
  const poller: Poller = {
    getSnapshot: () => snapshot,
    getAttention: () => ({}),
    /* eslint-disable @typescript-eslint/no-empty-function */
    onSnapshot: () => () => {},
    pollOnce: async () => {},
    refreshEnv: async () => {},
    runClaudeSweepOnce: async () => {},
    applyRegistry: () => undefined,
    start: () => {},
    stop: () => {},
    /* eslint-enable @typescript-eslint/no-empty-function */
  };
  const storage = createStorage(dir);
  return {
    app: createApi({ poller, envs: ENVIRONMENTS, storage,
      ...(extra.spawn === undefined ? {} : { spawn: extra.spawn }),
      ...(extra.closePaneFn === undefined ? {} : { closePaneFn: extra.closePaneFn }),
      closeDeferMs: 1 }),
    storage,
  };
}

function log(storage: ReturnType<typeof createStorage>, bid: string, tid: string): LogEntry[] {
  const parsed = BoardSchema.parse(storage.getBoard(bid));
  return parsed.tasks.find((t) => t.id === tid)?.log ?? [];
}

function json(over: Record<string, unknown>): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(over) };
}

// The invariant §4 in code: a session bound to one card may APPEND to another it is not bound to.
describe("cross-card append — the invariant permits adding to another card", () => {
  it("accepts an append to card B from a session bound to card A, and names that session", async () => {
    const { app, storage } = makeApi([board([task({ id: "t_aaaaaaa", sessions: [link()] }), task({ id: "t_bbbbbbb", sessions: [] })])], [row()]);

    const res = await app.request("/api/boards/b/tasks/t_bbbbbbb/log", json({ kind: "note", text: "a cross-card note", env: "work-local", paneId: "w1:p1" }));

    expect(res.status).toBe(201);
    const entries = log(storage, "b", "t_bbbbbbb");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toEqual({ sessionId: SID, name: "worker-a" });
    // The card the writer is bound to is untouched — appending elsewhere adds nothing to it.
    expect(log(storage, "b", "t_aaaaaaa")).toHaveLength(0);
  });

  it("still refuses a pane bound to NO card anywhere, with 403", async () => {
    const { app, storage } = makeApi([board([task({ id: "t_bbbbbbb", sessions: [] })])], [row({ paneId: "w1:p9", sessionId: null })]);

    const res = await app.request("/api/boards/b/tasks/t_bbbbbbb/log", json({ kind: "note", text: "x", env: "work-local", paneId: "w1:p9" }));

    expect(res.status).toBe(403);
    expect(log(storage, "b", "t_bbbbbbb")).toHaveLength(0);
  });
});

describe("created — provenance is the first log entry, never the description", () => {
  it("stamps who created the card and which it follows up, leaving description as sent", async () => {
    const { app, storage } = makeApi([board([task({ id: "t_src1234", sessions: [link({ name: "creator-x" })] })])], [row()]);

    const res = await app.request("/api/boards/b/tasks", json({
      title: "New card", description: "just the task statement",
      env: "work-local", paneId: "w1:p1", sourceBoardId: "b", sourceTaskId: "t_src1234",
    }));
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string; description: string };
    expect(created.description).toBe("just the task statement");

    const entries = log(storage, "b", created.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("created");
    expect(entries[0]?.source).toBe("corral");
    expect(entries[0]?.text).toContain("created by creator-x (work-local:w1:p1)");
    expect(entries[0]?.text).toContain("follow-up of b/t_src1234");
  });

  it("stamps a bare `created` with no session for the web add (no creator coordinates)", async () => {
    const { app, storage } = makeApi([board([])], []);

    const res = await app.request("/api/boards/b/tasks", json({ title: "Web card" }));
    const created = await res.json() as { id: string };

    const entries = log(storage, "b", created.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "created", source: "corral", text: "card created" });
  });

  it("falls back to the raw env:paneId key when the creator's coordinates resolve to no card", async () => {
    // Coordinates present, but the pane is bound to no card anywhere — the middle branch between a
    // named creator and the web add. The entry must name the key, never crash or say "undefined".
    const { app, storage } = makeApi([board([])], [row({ paneId: "w1:p9", sessionId: null })]);

    const res = await app.request("/api/boards/b/tasks", json({ title: "Orphan", env: "work-local", paneId: "w1:p9" }));
    const created = await res.json() as { id: string };

    expect(log(storage, "b", created.id)[0]?.text).toBe("created by work-local:w1:p9");
  });

  it("keeps the created entry off the create RESPONSE — the log rides one route only", async () => {
    const { app } = makeApi([board([])], []);
    const res = await app.request("/api/boards/b/tasks", json({ title: "x", env: "work-local", paneId: "w1:p1" }));
    expect(Object.hasOwn(await res.json() as object, "log")).toBe(false);
  });
});

describe("session_bound / session_detached", () => {
  it("stamps session_bound naming the session on a real attach, and nothing on the idempotent re-attach", async () => {
    const { app, storage } = makeApi([board([task({ id: "t_aaaaaaa", sessions: [] })])], [row()]);

    await app.request("/api/boards/b/tasks/t_aaaaaaa/attach", json({ env: "work-local", paneId: "w1:p1", name: "worker-a" }));
    let entries = log(storage, "b", "t_aaaaaaa");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "session_bound", source: "corral" });
    expect(entries[0]?.text).toContain("work-local:w1:p1");

    // A second attach of the same live session is idempotent — no second lifecycle line.
    await app.request("/api/boards/b/tasks/t_aaaaaaa/attach", json({ env: "work-local", paneId: "w1:p1", name: "worker-a" }));
    entries = log(storage, "b", "t_aaaaaaa");
    expect(entries.filter((e) => e.kind === "session_bound")).toHaveLength(1);
  });

  it("stamps session_detached only when a link was actually removed", async () => {
    const { app, storage } = makeApi([board([task({ id: "t_aaaaaaa", sessions: [link()] })])], [row()]);

    await app.request("/api/boards/b/tasks/t_aaaaaaa/detach", json({ env: "work-local", paneId: "w1:p1", sessionId: SID }));
    expect(log(storage, "b", "t_aaaaaaa").some((e) => e.kind === "session_detached")).toBe(true);

    // A detach that resolves nothing (unknown pane) is a no-op and stamps no entry.
    const { app: app2, storage: st2 } = makeApi([board([task({ id: "t_aaaaaaa", sessions: [] })])], []);
    await app2.request("/api/boards/b/tasks/t_aaaaaaa/detach", json({ env: "work-local", paneId: "w1:p9", sessionId: null }));
    expect(log(st2, "b", "t_aaaaaaa")).toHaveLength(0);
  });
});

describe("status_changed — columns and nothing more, only on an actual move", () => {
  it("stamps the from→to columns on a status change", async () => {
    const { app, storage } = makeApi([board([task({ id: "t_aaaaaaa", status: "todo" })])], []);

    await app.request("/api/boards/b/tasks/t_aaaaaaa", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "doing" }) });

    const entries = log(storage, "b", "t_aaaaaaa");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "status_changed", source: "corral", text: "todo → doing" });
  });

  it("stamps NOTHING when the status is unchanged, or when only the title moves", async () => {
    const { app, storage } = makeApi([board([task({ id: "t_aaaaaaa", status: "todo", title: "old" })])], []);

    await app.request("/api/boards/b/tasks/t_aaaaaaa", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "todo" }) });
    await app.request("/api/boards/b/tasks/t_aaaaaaa", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "new" }) });

    expect(log(storage, "b", "t_aaaaaaa")).toHaveLength(0);
  });

  it("stamps status_changed on a board move that remaps the column", async () => {
    const src = board([task({ id: "t_aaaaaaa", status: "doing" })], "src");
    const dst = BoardSchema.parse({ id: "dst", label: "DST", columns: [{ id: "backlog", label: "Backlog" }], tasks: [], spawnPresets: [], defaultSpawnPresetId: null });
    const { app, storage } = makeApi([src, dst], []);

    await app.request("/api/boards/src/tasks/t_aaaaaaa/move", json({ toBoardId: "dst" }));

    const entries = log(storage, "dst", "t_aaaaaaa");
    expect(entries.some((e) => e.kind === "status_changed" && e.text === "doing → backlog")).toBe(true);
  });
});

describe("session_spawned / session_closed", () => {
  const spawnResult = {
    paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1",
    workspaceLabel: "corral", tabLabel: "t-b", cwdSnapshot: "/proj", idempotent: false,
  };

  it("stamps session_spawned on the target card when a new session launches", async () => {
    const spawn: SpawnFn = vi.fn(async () => spawnResult);
    const { app, storage } = makeApi([board([task({ id: "t_aaaaaaa", sessions: [] })])], [], { spawn });

    const res = await app.request("/api/boards/b/tasks/t_aaaaaaa/spawn", json({ env: "work-local", brief: "go", repo: "corral" }));
    expect(res.status).toBe(200);

    const entries = log(storage, "b", "t_aaaaaaa");
    expect(entries.some((e) => e.kind === "session_spawned" && e.source === "corral")).toBe(true);
  });

  it("stamps NO session_spawned when the spawn is idempotent (an existing pane is adopted, not launched)", async () => {
    const SID2 = "22222222-2222-3333-4444-555555555555";
    // The card already carries the link the idempotent spawn will re-point to; the pane is live.
    const existing = link({ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", sessionId: SID2 });
    const spawn: SpawnFn = vi.fn(async () => ({ ...spawnResult, idempotent: true }));
    const { app, storage } = makeApi(
      [board([task({ id: "t_aaaaaaa", sessions: [existing] })])],
      [row({ paneId: "w1:p2", sessionId: SID2 })],
      { spawn },
    );

    const res = await app.request("/api/boards/b/tasks/t_aaaaaaa/spawn", json({ env: "work-local", brief: "go", repo: "corral" }));
    expect(res.status).toBe(200);
    // A wrong impl that hoisted the stamp out of the "new session" arm would emit a spurious line here.
    expect(log(storage, "b", "t_aaaaaaa").some((e) => e.kind === "session_spawned")).toBe(false);
  });

  it("stamps session_closed while KEEPING the link (suspend, not destroy)", async () => {
    const closePaneFn = vi.fn(async () => undefined);
    const { app, storage } = makeApi([board([task({ id: "t_aaaaaaa", sessions: [link()] })])], [row()], { closePaneFn });

    const res = await app.request("/api/boards/b/tasks/t_aaaaaaa/sessions/work-local/w1:p1/close", json({}));
    expect(res.status).toBe(200);

    const parsed = BoardSchema.parse(storage.getBoard("b"));
    const t = parsed.tasks.find((x) => x.id === "t_aaaaaaa");
    expect(t?.sessions).toHaveLength(1); // link intact — the card still renders detached
    expect(t?.log.some((e) => e.kind === "session_closed" && e.source === "corral")).toBe(true);
  });

  it("stamps NO session_closed when the close is refused (pane not ours)", async () => {
    const closePaneFn = vi.fn(async () => undefined);
    // A live row whose sessionId does NOT match the link's → pane_reused guard fires.
    const { app, storage } = makeApi([board([task({ id: "t_aaaaaaa", sessions: [link()] })])], [row({ sessionId: "99999999-2222-3333-4444-555555555555" })], { closePaneFn });

    const res = await app.request("/api/boards/b/tasks/t_aaaaaaa/sessions/work-local/w1:p1/close", json({}));
    expect(res.status).toBe(409);
    expect(log(storage, "b", "t_aaaaaaa")).toHaveLength(0);
    expect(closePaneFn).not.toHaveBeenCalled();
  });
});
