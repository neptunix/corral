import type { Board, LogEntry } from "@shared/board-schema.ts";
import { BoardStateSchema, EnrichedTaskSchema } from "@shared/board-schema.ts";
import type { Snapshot } from "@shared/schema";
import { WhoamiTaskSchema } from "@shared/whoami-schema.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ENVIRONMENTS } from "../environments.ts";
import { createApi } from "../server/api.ts";
import type { Poller } from "../server/poller.ts";
import { createStorage } from "../server/storage.ts";
import { buildWhoami } from "../server/whoami.ts";

const SID = "11111111-2222-3333-4444-555555555555";

function entry(at: number, text: string): LogEntry {
  return { at, source: { sessionId: SID, name: "worker-a" }, kind: "note", text };
}

const LOG: LogEntry[] = [entry(100, "first"), entry(200, "second")];

function board(): Board {
  return {
    id: "b", label: "B",
    columns: [{ id: "todo", label: "Todo" }],
    tasks: [{
      id: "t_abcdefg", title: "T", description: "d", status: "todo", priority: null,
      createdAt: 1, updatedAt: 2, log: LOG,
      sessions: [{
        env: "work-local", paneId: "w1:p1", tabId: "tab1", tabLabel: "t", workspaceId: "ws1",
        workspaceLabel: "w", name: "worker-a", cwdSnapshot: "/repo", sessionId: SID,
      }],
    }],
    spawnPresets: [], defaultSpawnPresetId: null,
  };
}

const row = {
  env: "work-local", paneId: "w1:p1", status: "working", agent: "claude", cwd: "/repo",
  tab: "t", workspace: "w", tabId: "tab1", workspaceId: "ws1", sessionId: SID,
  recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null,
  statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null,
  registryStatus: null, claudeName: "worker-a", claudeNameUserSet: true,
} as const;

const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [row] };

function seedStorage(): ReturnType<typeof createStorage> {
  const dir = mkdtempSync(path.join(tmpdir(), "corral-log-wire-"));
  mkdirSync(path.join(dir, "boards"), { recursive: true });
  writeFileSync(path.join(dir, "boards", "b.json"), JSON.stringify(board()));
  return createStorage(dir);
}

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

describe("the log does not ride the stream frame", () => {
  it("serves logCount and lastLogAt instead of the entries, in both halves of the frame", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: seedStorage() });

    const res = await app.request("/api/state?board=b");
    const body: unknown = await res.json();
    const state = BoardStateSchema.parse(body);

    expect(state.tasks[0]?.logCount).toBe(2);
    expect(state.tasks[0]?.lastLogAt).toBe(200);
    // The raw body, not the parsed value: the schema strips unknown keys, so parsing first would
    // hide a log that really was sent.
    expect(JSON.stringify(body)).not.toContain("second");
  });

  it("EnrichedTask has no log field at all", () => {
    const parsed = EnrichedTaskSchema.parse({
      id: "t_abcdefg", title: "T", description: "d", status: "todo", priority: null,
      createdAt: 1, updatedAt: 2, sessions: [], log: LOG, logCount: 2, lastLogAt: 200,
    });
    expect(Object.keys(parsed)).not.toContain("log");
  });
});

describe("whoami carries the log's existence", () => {
  it("reports the counters on the card block", () => {
    const out = buildWhoami({
      resolution: { ok: true, env: ENVIRONMENTS[0]!, row },
      envs: ENVIRONMENTS, snapshot, boards: [board()],
    });

    expect(out.resolved).toBe(true);
    const task = out.resolved ? out.task : null;
    expect(task?.logCount).toBe(2);
    expect(task?.lastLogAt).toBe(200);
  });

  it("defaults the counters when an older corral server omits them", () => {
    const parsed = WhoamiTaskSchema.parse({
      boardId: "b", boardLabel: "B", taskId: "t_abcdefg", title: "T", description: "d",
      status: "todo", priority: null, columns: [], sessions: [],
    });
    expect(parsed.logCount).toBe(0);
    expect(parsed.lastLogAt).toBeNull();
  });
});
