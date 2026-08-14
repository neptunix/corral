import { BoardStateSchema, GlobalStateSchema } from "@shared/board-schema";
import { DiagnosticsSnapshotSchema, EMPTY_DIAGNOSTICS, type Check } from "@shared/diagnostics-schema";
import type { Snapshot } from "@shared/schema";
import { SnapshotSchema } from "@shared/schema";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { createApi } from "../server/api.ts";
import { createDiagnosticsStore } from "../server/diagnostics-store.ts";
import type { Poller } from "../server/poller.ts";
import { createStorage } from "../server/storage.ts";

const problem: Check = {
  id: "jq-present", key: "jq-present@work", title: "jq is not installed", state: "problem",
  severity: "fatal", detail: "", doc: null, scope: { kind: "env", envId: "work" },
  class: "cheap", checkedAt: 1, startupOkLine: false, haltsStartup: false,
};

const ENVS: readonly HerdrEnv[] = [
  { id: "work", label: "Work", kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {} },
];

function stubPoller(): Poller {
  const snap: Snapshot = { envs: { work: { reachable: true } }, sessions: [] };
  return {
    getSnapshot: () => snap,
    getAttention: () => ({}),
    onSnapshot: () => () => undefined,
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
}

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "diagnostics-route-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

/** Board `b1` on disk, so the `?board=` branch of /api/state actually fires. */
async function seedBoard(app: ReturnType<typeof createApi>): Promise<void> {
  await app.request("/api/boards", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "b1" }),
  });
}

/** Minimal API harness: a stub poller, a real store, a real board, and a counted refresh. */
async function buildTestApi() {
  const store = createDiagnosticsStore({ selfVersion: "0.6.5" });
  store.put("cheap", [problem]);
  let refreshes = 0;
  const app = createApi({
    poller: stubPoller(),
    envs: ENVS,
    storage: createStorage(tmpDir),
    diagnostics: store,
    refreshDiagnostics: async () => { refreshes += 1; },
    allowedOrigins: [],
  });
  await seedBoard(app);
  return { app, store, refreshes: () => refreshes };
}

/** The same harness with NOTHING wired — the shape every existing createApi caller has. */
async function buildBareApi() {
  const app = createApi({ poller: stubPoller(), envs: ENVS, storage: createStorage(tmpDir) });
  await seedBoard(app);
  return app;
}

describe("GlobalStateSchema", () => {
  it("parses a frame with no diagnostics field, defaulting it — an older frame must not be dropped", () => {
    const parsed = GlobalStateSchema.safeParse({ unassigned: [], envs: {}, attention: {} });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.diagnostics).toEqual(EMPTY_DIAGNOSTICS);
  });

  it("carries a real snapshot through, on the board shape too", () => {
    const snap = { ...EMPTY_DIAGNOSTICS, answered: ["cheap"], rollup: { fatal: 1, warning: 2, info: 0, pending: 0 } };
    const g = GlobalStateSchema.safeParse({ unassigned: [], envs: {}, attention: {}, diagnostics: snap });
    expect(g.success && g.data.diagnostics.rollup.warning).toBe(2);
    expect(BoardStateSchema.shape.diagnostics).toBeDefined();
  });

  it("hands each frame its OWN default — the default is a function, not one shared object", () => {
    const a = GlobalStateSchema.parse({ unassigned: [], envs: {}, attention: {} });
    const b = GlobalStateSchema.parse({ unassigned: [], envs: {}, attention: {} });
    expect(a.diagnostics).not.toBe(b.diagnostics);
    expect(a.diagnostics.checks).not.toBe(EMPTY_DIAGNOSTICS.checks);
  });
});

describe("the board response — the only one the client fetches", () => {
  it("carries the live snapshot, not the all-green default", async () => {
    const { app } = await buildTestApi();
    const res = await app.request("/api/state?board=b1");
    const body: unknown = await res.json();
    const parsed = BoardStateSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.diagnostics.rollup.fatal).toBe(1);
    expect(parsed.success && parsed.data.diagnostics.answered).toEqual(["cheap"]);
  });

  it("with no store wired says nothing has looked — answered is empty, not all-clear", async () => {
    const app = await buildBareApi();
    const body: unknown = await (await app.request("/api/state?board=b1")).json();
    const parsed = BoardStateSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.diagnostics).toEqual(EMPTY_DIAGNOSTICS);
  });
});

describe("the bare /api/state", () => {
  it("still returns a Snapshot — it was never a GlobalState", async () => {
    const { app } = await buildTestApi();
    const body: unknown = await (await app.request("/api/state")).json();
    expect(SnapshotSchema.safeParse(body).success).toBe(true);
  });
});

describe("GET /api/diagnostics", () => {
  it("answers with a valid snapshot", async () => {
    const { app } = await buildTestApi();
    const res = await app.request("/api/diagnostics");
    expect(res.status).toBe(200);
    expect(DiagnosticsSnapshotSchema.safeParse(await res.json()).success).toBe(true);
  });

  it("is read-only — it never runs the sweep", async () => {
    const { app, refreshes } = await buildTestApi();
    await app.request("/api/diagnostics");
    expect(refreshes()).toBe(0);
  });

  it("503 when no store is wired — never a fabricated all-green snapshot", async () => {
    const app = await buildBareApi();
    expect((await app.request("/api/diagnostics")).status).toBe(503);
  });
});

describe("POST /api/diagnostics/refresh", () => {
  it("runs the refresh once and returns the snapshot", async () => {
    const { app, refreshes } = await buildTestApi();
    const res = await app.request("/api/diagnostics/refresh", { method: "POST" });
    expect(res.status).toBe(200);
    expect(refreshes()).toBe(1);
    expect(DiagnosticsSnapshotSchema.safeParse(await res.json()).success).toBe(true);
  });

  it("rejects GET — a request that makes SSH round trips is not a safe method", async () => {
    const { app } = await buildTestApi();
    expect((await app.request("/api/diagnostics/refresh")).status).toBe(404);
  });

  it("throttles a rapid second POST — the first ran, the second only reads", async () => {
    const { app, refreshes } = await buildTestApi();
    const first = await app.request("/api/diagnostics/refresh", { method: "POST" });
    const second = await app.request("/api/diagnostics/refresh", { method: "POST" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(refreshes()).toBe(1);
    // Still a real snapshot, not an error body: the caller asked a question that has an answer.
    expect(DiagnosticsSnapshotSchema.safeParse(await second.json()).success).toBe(true);
  });

  it("collapses a burst that never awaits — one sweep, not one per request", async () => {
    // The shape a hostile (or looping) page actually produces: fire-and-forget POSTs, all in flight at
    // once. A floor measured only from completion would let every one of them through.
    const { app, refreshes } = await buildTestApi();
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => app.request("/api/diagnostics/refresh", { method: "POST" })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(refreshes()).toBe(1);
  });

  it("503 when no refresh is wired", async () => {
    const app = await buildBareApi();
    expect((await app.request("/api/diagnostics/refresh", { method: "POST" })).status).toBe(503);
  });
});
