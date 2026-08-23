import type { Board } from "@shared/board-schema.ts";
import { BoardSchema, LOG_ENTRY_TEXT_MAX } from "@shared/board-schema.ts";
import type { SessionRow, Snapshot } from "@shared/schema";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { ENVIRONMENTS } from "../environments.ts";
import { createClient } from "../mcp/client.ts";
import { createApi } from "../server/api.ts";
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

function board(over: { readonly sessionId?: string | null } = {}): Board {
  return {
    id: "b", label: "B",
    columns: [{ id: "todo", label: "Todo" }],
    tasks: [{
      id: "t_abcdefg", title: "T", description: "d", status: "todo", priority: null,
      createdAt: 1, updatedAt: 2, log: [],
      sessions: [{
        env: "work-local", paneId: "w1:p1", tabId: "tab1", tabLabel: "t", workspaceId: "ws1",
        workspaceLabel: "w", name: "stored-name", cwdSnapshot: "/repo",
        sessionId: over.sessionId === undefined ? SID : over.sessionId,
      }],
    }],
    spawnPresets: [], defaultSpawnPresetId: null,
  };
}

let dir: string;

function makeApi(sessions: readonly SessionRow[], b: Board = board()): {
  readonly app: ReturnType<typeof createApi>;
  readonly storage: ReturnType<typeof createStorage>;
} {
  mkdirSync(path.join(dir, "boards"), { recursive: true });
  writeFileSync(path.join(dir, "boards", "b.json"), JSON.stringify(b));
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
  return { app: createApi({ poller, envs: ENVIRONMENTS, storage }), storage };
}

function appendBody(over: Record<string, unknown> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "note", text: "decided X because Y", env: "work-local", paneId: "w1:p1", ...over }),
  };
}

function storedLog(storage: ReturnType<typeof createStorage>): Board["tasks"][number]["log"] {
  const parsed = BoardSchema.parse(storage.getBoard("b"));
  return parsed.tasks[0]?.log ?? [];
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "corral-log-route-"));
});

describe("POST /api/boards/:bid/tasks/:tid/log", () => {
  it("appends the entry and stamps `at` itself, ignoring any the caller supplies", async () => {
    const { app, storage } = makeApi([row()]);
    const before = Date.now();

    const res = await app.request("/api/boards/b/tasks/t_abcdefg/log", appendBody({ at: 5 }));

    expect(res.status).toBe(201);
    const log = storedLog(storage);
    expect(log).toHaveLength(1);
    expect(log[0]?.text).toBe("decided X because Y");
    expect(log[0]?.kind).toBe("note");
    expect(log[0]?.at).toBeGreaterThanOrEqual(before);
  });

  it("captures the session's own registry name, ungated, over the link's stored one", async () => {
    const { app, storage } = makeApi([row({ claudeName: "worker-alpha", claudeNameUserSet: false })]);

    await app.request("/api/boards/b/tasks/t_abcdefg/log", appendBody());

    expect(storedLog(storage)[0]?.source).toEqual({ sessionId: SID, name: "worker-alpha" });
  });

  it("falls back to the link's stored name when the registry has not answered", async () => {
    const { app, storage } = makeApi([row()]);

    await app.request("/api/boards/b/tasks/t_abcdefg/log", appendBody());

    expect(storedLog(storage)[0]?.source).toEqual({ sessionId: SID, name: "stored-name" });
  });

  // The spawn-time shape: the link exists, Claude has not registered, so there is no uuid to carry.
  // A schema demanding one would be unwritable at exactly that moment.
  it("writes an entry with a null sessionId for a session that has not registered yet", async () => {
    const { app, storage } = makeApi([], board({ sessionId: null }));

    const res = await app.request("/api/boards/b/tasks/t_abcdefg/log", appendBody());

    expect(res.status).toBe(201);
    expect(storedLog(storage)[0]?.source).toEqual({ sessionId: null, name: "stored-name" });
  });

  it("refuses a session that is not on the card, and writes nothing", async () => {
    const { app, storage } = makeApi([row({ paneId: "w1:p9", sessionId: null })]);

    const res = await app.request(
      "/api/boards/b/tasks/t_abcdefg/log",
      appendBody({ paneId: "w1:p9" }),
    );

    expect(res.status).toBe(403);
    expect(storedLog(storage)).toHaveLength(0);
  });

  // The rule that actually protects the card, and the one a naive env+paneId comparison would get
  // wrong: a link carrying a sessionId binds THAT session, not whoever now holds its pane. Without
  // this pair, the refusal test above passes against an implementation that only matches the pane —
  // under which a fresh session inheriting a pane writes onto the previous session's card.
  it("refuses a different session that inherited the bound pane", async () => {
    const OTHER = "99999999-2222-3333-4444-555555555555";
    const { app, storage } = makeApi([row({ sessionId: OTHER })]);

    const res = await app.request("/api/boards/b/tasks/t_abcdefg/log", appendBody());

    expect(res.status).toBe(403);
    expect(storedLog(storage)).toHaveLength(0);
  });

  it("accepts the bound session after a herdr restart moved it to another pane", async () => {
    const { app, storage } = makeApi([row({ paneId: "w1:p7" })]);

    const res = await app.request("/api/boards/b/tasks/t_abcdefg/log", appendBody({ paneId: "w1:p7" }));

    expect(res.status).toBe(201);
    expect(storedLog(storage)).toHaveLength(1);
  });

  it("404s on an unknown card rather than writing anywhere", async () => {
    const { app } = makeApi([row()]);

    const res = await app.request("/api/boards/b/tasks/t_nope123/log", appendBody());

    expect(res.status).toBe(404);
  });

  it("refuses an empty note, a kind outside the enum, an unknown env, and an oversized body", async () => {
    const { app, storage } = makeApi([row()]);
    const post = async (over: Record<string, unknown>): Promise<number> =>
      (await app.request("/api/boards/b/tasks/t_abcdefg/log", appendBody(over))).status;

    expect(await post({ text: "   " })).toBe(400);
    expect(await post({ kind: "decision" })).toBe(400);
    // A session may only name an environment corral actually serves.
    expect(await post({ env: "nope" })).toBe(400);
    // The stored text is truncated, but the BODY cap is what bounds the work one request can force.
    expect(await post({ text: "x".repeat(LOG_ENTRY_TEXT_MAX * 20 + 1) })).toBe(400);
    expect(storedLog(storage)).toHaveLength(0);
  });

  // The client and the route are only ever exercised apart — the route test builds its own body, the
  // tool tests stub the client. Renaming a response field would leave both green and break every real
  // corral_task_log call, so this drives the real client against the real route.
  it("round-trips through the MCP client against the real route", async () => {
    const { app } = makeApi([row()]);
    // The client only ever passes a string URL; Hono's `request` takes the same.
    const client = createClient("http://corral.test", async (input, init) =>
      app.request(input instanceof URL ? input.toString() : input, init));

    const res = await client.appendLog({
      boardId: "b", taskId: "t_abcdefg", env: "work-local", paneId: "w1:p1", text: "decided X",
    });

    expect(res).toEqual({ ok: true, at: expect.any(Number), logCount: 1 });
  });

  it("loses nothing when two sessions append at once", async () => {
    const { app, storage } = makeApi([row()]);

    await Promise.all(Array.from({ length: 12 }, async (_, i) =>
      app.request("/api/boards/b/tasks/t_abcdefg/log", appendBody({ text: `note ${String(i)}` }))));

    expect(storedLog(storage)).toHaveLength(12);
  });
});
