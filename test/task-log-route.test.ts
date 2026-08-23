import type { Board } from "@shared/board-schema.ts";
import { BoardSchema } from "@shared/board-schema.ts";
import type { SessionRow, Snapshot } from "@shared/schema";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { ENVIRONMENTS } from "../environments.ts";
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

  it("404s on an unknown card rather than writing anywhere", async () => {
    const { app } = makeApi([row()]);

    const res = await app.request("/api/boards/b/tasks/t_nope123/log", appendBody());

    expect(res.status).toBe(404);
  });

  it("refuses an empty note and a kind outside the enum", async () => {
    const { app, storage } = makeApi([row()]);

    expect((await app.request("/api/boards/b/tasks/t_abcdefg/log", appendBody({ text: "   " }))).status).toBe(400);
    expect((await app.request("/api/boards/b/tasks/t_abcdefg/log", appendBody({ kind: "decision" }))).status).toBe(400);
    expect(storedLog(storage)).toHaveLength(0);
  });

  it("loses nothing when two sessions append at once", async () => {
    const { app, storage } = makeApi([row()]);

    await Promise.all(Array.from({ length: 12 }, async (_, i) =>
      app.request("/api/boards/b/tasks/t_abcdefg/log", appendBody({ text: `note ${String(i)}` }))));

    expect(storedLog(storage)).toHaveLength(12);
  });
});
