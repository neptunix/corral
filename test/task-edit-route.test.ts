import type { Board } from "@shared/board-schema.ts";
import { BoardSchema } from "@shared/board-schema.ts";
import type { Snapshot } from "@shared/schema";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { ENVIRONMENTS } from "../environments.ts";
import { createApi } from "../server/api.ts";
import type { Poller } from "../server/poller.ts";
import { createStorage } from "../server/storage.ts";
import { descriptionRev } from "../shared/description-rev.ts";

const board: Board = BoardSchema.parse({
  id: "b", label: "B",
  columns: [{ id: "todo", label: "Todo" }, { id: "doing", label: "Doing" }],
  tasks: [{ id: "t_aaaaaaa", title: "T", description: "old", status: "todo", priority: null, createdAt: 1, updatedAt: 2, log: [], sessions: [] }],
  spawnPresets: [], defaultSpawnPresetId: null,
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "corral-edit-")); });

function makeApi(): { readonly app: ReturnType<typeof createApi>; readonly storage: ReturnType<typeof createStorage> } {
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
  return { app: createApi({ poller, envs: ENVIRONMENTS, storage, closeDeferMs: 1 }), storage };
}

function patch(body: Record<string, unknown>): RequestInit {
  return { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function stored(storage: ReturnType<typeof createStorage>): string | undefined {
  return BoardSchema.parse(storage.getBoard("b")).tasks[0]?.description;
}

const EDIT = "/api/boards/b/tasks/t_aaaaaaa/edit";

describe("PATCH /api/boards/:bid/tasks/:tid/edit", () => {
  it("applies a description whose baseRev matches and answers with the new rev", async () => {
    const { app, storage } = makeApi();
    const res = await app.request(EDIT, patch({ description: "new", baseRev: descriptionRev("b", "t_aaaaaaa", "old") }));
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ description: "new", descriptionRev: descriptionRev("b", "t_aaaaaaa", "new") });
    expect(stored(storage)).toBe("new");
  });

  it("refuses a stale baseRev with 409 and leaves the card untouched", async () => {
    const { app, storage } = makeApi();
    const res = await app.request(EDIT, patch({ description: "new", title: "X", baseRev: descriptionRev("b", "t_aaaaaaa", "other") }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "description_conflict" } });
    expect(stored(storage)).toBe("old");
    expect(BoardSchema.parse(storage.getBoard("b")).tasks[0]?.title).toBe("T");
  });

  it("refuses a description without baseRev", async () => {
    const { app, storage } = makeApi();
    const res = await app.request(EDIT, patch({ description: "new" }));
    expect(res.status).toBe(400);
    expect(stored(storage)).toBe("old");
  });

  it("refuses a baseRev without a description", async () => {
    const { app } = makeApi();
    expect((await app.request(EDIT, patch({ title: "X", baseRev: descriptionRev("b", "t_aaaaaaa", "old") }))).status).toBe(400);
  });

  it("applies a title-only edit without baseRev", async () => {
    const { app, storage } = makeApi();
    const res = await app.request(EDIT, patch({ title: "X" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: "X", descriptionRev: descriptionRev("b", "t_aaaaaaa", "old") });
    expect(BoardSchema.parse(storage.getBoard("b")).tasks[0]?.title).toBe("X");
  });

  it("leaves the plain PATCH last-write-wins for the web UI", async () => {
    const { app, storage } = makeApi();
    const res = await app.request("/api/boards/b/tasks/t_aaaaaaa", patch({ description: "ui" }));
    expect(res.status).toBe(200);
    expect(stored(storage)).toBe("ui");
  });
});
