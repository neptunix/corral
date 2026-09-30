import type { Board } from "@shared/board-schema.ts";
import { BoardSchema } from "@shared/board-schema.ts";
import type { Snapshot } from "@shared/schema";
import type { WhoamiResponse } from "@shared/whoami-schema.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { ENVIRONMENTS } from "../environments.ts";
import type { CorralClient } from "../mcp/client.ts";
import { createClient } from "../mcp/client.ts";
import { createIdentity } from "../mcp/identity.ts";
import { updateHandler } from "../mcp/tools/task-update.ts";
import { readHandler } from "../mcp/tools/task.ts";
import { createApi } from "../server/api.ts";
import type { Poller } from "../server/poller.ts";
import { createStorage } from "../server/storage.ts";

const board: Board = BoardSchema.parse({
  id: "b", label: "B",
  columns: [{ id: "todo", label: "Todo" }, { id: "done", label: "Done", type: "closed" }],
  tasks: [
    { id: "t_umbrell", title: "Umbrella", description: "umbrella text", status: "todo", priority: null, createdAt: 1, updatedAt: 1, log: [], sessions: [] },
    { id: "t_c2c2c2c", title: "C2", description: "c2 text", status: "todo", priority: null, createdAt: 1, updatedAt: 1, log: [], sessions: [] },
  ],
  spawnPresets: [], defaultSpawnPresetId: null,
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "corral-cas-e2e-")); });

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

// Real server route + real client; only whoami is stubbed, since it needs a live herdr pane.
function setup(): { readonly deps: { client: CorralClient; identity: ReturnType<typeof createIdentity> }; readonly stored: (tid: string) => string | undefined } {
  mkdirSync(path.join(dir, "boards"), { recursive: true });
  writeFileSync(path.join(dir, "boards", "b.json"), JSON.stringify(board));
  const snapshot: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
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
  const app = createApi({ poller, envs: ENVIRONMENTS, storage, closeDeferMs: 1 });
  const real = createClient("http://127.0.0.1:8787", async (input, init) => app.request(urlOf(input), init));
  const whoami: WhoamiResponse = {
    resolved: true,
    session: {
      env: "work-local", envLabel: "Work (local)", paneId: "w1:p1", tabId: "tab1", tabLabel: "a", workspaceId: "ws1",
      workspaceLabel: "repo", sessionId: null, sessionName: "a", claudeName: null, cwd: "/repo", status: "working",
      model: null, ctxPct: null, costUsd: null, fiveHourPct: null, sevenDayPct: null, account: null, remoteControl: null,
    },
    task: {
      boardId: "b", boardLabel: "B", taskId: "t_umbrell", title: "Umbrella", description: "umbrella text", status: "todo",
      priority: null, columns: [{ id: "todo", label: "Todo", closed: false }, { id: "done", label: "Done", closed: true }],
      sessions: [], logCount: 0, lastLogAtMs: null, spawnedBy: null,
    },
    envs: [{ id: "work-local", label: "Work (local)", kind: "local", reachable: true }],
  };
  const client: CorralClient = { ...real, whoami: async () => whoami };
  const identity = createIdentity(client, { paneId: "w1:p1", socket: null, cwd: "/repo" });
  return {
    deps: { client, identity },
    stored: (tid) => BoardSchema.parse(storage.getBoard("b")).tasks.find((t) => t.id === tid)?.description,
  };
}

function revOf(read: string): string {
  const m = /description rev: ([0-9a-f]{12})/.exec(read);
  if (m?.[1] === undefined) throw new Error(`no rev in: ${read}`);
  return m[1];
}

describe("description compare-and-swap, read → update → server", () => {
  it("rewrites ANOTHER card with the rev its read printed, then refuses that rev once stale", async () => {
    const { deps, stored } = setup();
    const rev = revOf(await readHandler(deps, { boardId: "b", taskId: "t_c2c2c2c" }));
    expect(await updateHandler(deps, { boardId: "b", taskId: "t_c2c2c2c", description: "c2 v2", baseRev: rev })).toContain("updated b/t_c2c2c2c");
    expect(stored("t_c2c2c2c")).toBe("c2 v2");
    expect(stored("t_umbrell")).toBe("umbrella text");
    expect(await updateHandler(deps, { boardId: "b", taskId: "t_c2c2c2c", description: "c2 v3", baseRev: rev })).toContain("changed since your read");
    expect(stored("t_c2c2c2c")).toBe("c2 v2");
  });

  it("rewrites the bound card with the rev its read printed, and chains the next write on the reply's rev", async () => {
    const { deps, stored } = setup();
    const rev = revOf(await readHandler(deps));
    const out = await updateHandler(deps, { description: "umbrella v2", baseRev: rev });
    expect(stored("t_umbrell")).toBe("umbrella v2");
    await updateHandler(deps, { description: "umbrella v3", baseRev: revOf(out) });
    expect(stored("t_umbrell")).toBe("umbrella v3");
  });

  it("refuses a rev read from a different card", async () => {
    const { deps, stored } = setup();
    const c2Rev = revOf(await readHandler(deps, { boardId: "b", taskId: "t_c2c2c2c" }));
    expect(await updateHandler(deps, { description: "x", baseRev: c2Rev })).toContain("changed since your read");
    expect(stored("t_umbrell")).toBe("umbrella text");
  });
});
