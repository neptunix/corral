import type { Snapshot } from "@shared/schema";
import { describe, expect, it, vi } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { createApi } from "../server/api.ts";
import type { FleetRestore, FleetRestoreRun } from "../server/fleet-restore.ts";
import type { Poller } from "../server/poller.ts";

function stubPoller(): Poller {
  const snap: Snapshot = { envs: {}, sessions: [] };
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

const ENVS: readonly HerdrEnv[] = [
  { id: "e1", label: "E1", kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {} },
];

function appWith(result: FleetRestoreRun) {
  const run = vi.fn(async () => result);
  const fleetRestore: FleetRestore = { run };
  const app = createApi({ poller: stubPoller(), envs: ENVS, fleetRestore });
  return { app, run };
}

function post(app: ReturnType<typeof appWith>["app"], body?: string) {
  return app.request("/api/fleet/restore", {
    method: "POST",
    ...(body !== undefined ? { body, headers: { "content-type": "application/json" } } : {}),
  });
}

describe("POST /api/fleet/restore", () => {
  it("200 with the report on ok; empty body is accepted as {}", async () => {
    const report = { dryRun: false, envs: {} };
    const { app, run } = appWith({ status: "ok", report });
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(report);
    expect(run).toHaveBeenCalledWith({});
  });

  it("forwards env and dryRun from the body", async () => {
    const { app, run } = appWith({ status: "ok", report: { dryRun: true, envs: {} } });
    await post(app, JSON.stringify({ env: "e1", dryRun: true }));
    expect(run).toHaveBeenCalledWith({ env: "e1", dryRun: true });
  });

  it("404 no_mirror / 500 mirror_unreadable / 400 unknown_env / 409 restore_in_flight", async () => {
    expect((await post(appWith({ status: "no_mirror" }).app)).status).toBe(404);
    expect((await post(appWith({ status: "mirror_unreadable", message: "bad" }).app)).status).toBe(500);
    expect((await post(appWith({ status: "unknown_env", env: "x" }).app)).status).toBe(400);
    expect((await post(appWith({ status: "in_flight" }).app)).status).toBe(409);
  });

  it("400 on malformed JSON and on a bad body shape, without calling the engine", async () => {
    const { app, run } = appWith({ status: "ok", report: { dryRun: false, envs: {} } });
    expect((await post(app, "{nope")).status).toBe(400);
    expect((await post(app, JSON.stringify({ env: 5 }))).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("503 when no engine is wired", async () => {
    const app = createApi({ poller: stubPoller(), envs: ENVS });
    expect((await post(app)).status).toBe(503);
  });
});
