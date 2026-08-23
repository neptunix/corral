import type { AttentionMap, CardSignalResponse, Snapshot } from "@shared/schema";
import { CardSignalResponseSchema } from "@shared/schema";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ENVIRONMENTS } from "../environments.ts";
import { createApi } from "../server/api.ts";
import type { Poller } from "../server/poller.ts";
import { createStorage } from "../server/storage.ts";

const snap: Snapshot = {
  envs: { "work-local": { reachable: true } },
  sessions: [{
    env: "work-local", paneId: "w1:p1", status: "working", agent: "claude", cwd: "/repo",
    tab: "t", workspace: "w", tabId: "tab1", workspaceId: "ws1",
    sessionId: "11111111-2222-3333-4444-555555555555",
    recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null,
    statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null,
    registryStatus: null, claudeName: null, claudeNameUserSet: null,
  }],
};
const attention: AttentionMap = {};
const poller: Poller = {
  getSnapshot: () => snap,
  getAttention: () => attention,
  onSnapshot: () => () => undefined,
  pollOnce: async () => undefined,
  refreshEnv: async () => undefined,
  runClaudeSweepOnce: async () => undefined,
  applyRegistry: () => undefined,
  start: () => undefined,
  stop: () => undefined,
};

async function attach(app: ReturnType<typeof createApi>, description: string): Promise<void> {
  await app.request("/api/boards", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Test" }),
  });
  const { id: tid } = await (await app.request("/api/boards/test/tasks", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Some task", status: "todo", description }),
  })).json() as { id: string };
  await app.request(`/api/boards/test/tasks/${tid}/attach`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ env: "work-local", paneId: "w1:p1", name: "a", workspaceLabel: "w", cwdSnapshot: "/repo", idempotent: false }),
  });
}

describe("GET /api/card-signal", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "card-signal-route-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("reports empty:true for a bound task with a blank description", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    await attach(app, "");
    const res = await app.request("/api/card-signal?paneId=w1%3Ap1&cwd=%2Frepo");
    expect(res.status).toBe(200);
    const body = CardSignalResponseSchema.parse(await res.json());
    expect(body.empty).toBe(true);
  });

  it("reports empty:false for a bound task with a real description", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    await attach(app, "the actual task");
    const res = await app.request("/api/card-signal?paneId=w1%3Ap1&cwd=%2Frepo");
    expect(res.status).toBe(200);
    const body = CardSignalResponseSchema.parse(await res.json());
    expect(body.empty).toBe(false);
  });

  it("reports empty:false for an unresolvable pane", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    const res = await app.request("/api/card-signal?paneId=w9%3Ap9&cwd=%2Frepo");
    expect(res.status).toBe(200);
    const body = await res.json() as CardSignalResponse;
    expect(body.empty).toBe(false);
  });

  it("reports empty:false for a resolved pane with no card", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    const res = await app.request("/api/card-signal?paneId=w1%3Ap1&cwd=%2Frepo");
    expect(res.status).toBe(200);
    const body = await res.json() as CardSignalResponse;
    expect(body.empty).toBe(false);
  });

  it("400s on a missing paneId", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    const res = await app.request("/api/card-signal?cwd=%2Frepo");
    expect(res.status).toBe(400);
  });

  it("400s on a malformed paneId", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    const res = await app.request("/api/card-signal?paneId=" + encodeURIComponent("w1;rm -rf /"));
    expect(res.status).toBe(400);
  });

  it("400s on an empty paneId", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    const res = await app.request("/api/card-signal?paneId=");
    expect(res.status).toBe(400);
  });

  it("reports empty:false when storage is absent", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS });
    const res = await app.request("/api/card-signal?paneId=w1%3Ap1&cwd=%2Frepo");
    expect(res.status).toBe(200);
    const body = await res.json() as CardSignalResponse;
    expect(body.empty).toBe(false);
  });

  it("reports empty:false rather than 500 on an unparseable board file", async () => {
    const boardsDir = path.join(tmpDir, "boards");
    mkdirSync(boardsDir, { recursive: true });
    writeFileSync(path.join(boardsDir, "broken.json"), "{not json");
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    const res = await app.request("/api/card-signal?paneId=w1%3Ap1&cwd=%2Frepo");
    expect(res.status).toBe(200);
    const body = await res.json() as CardSignalResponse;
    expect(body.empty).toBe(false);
  });
});
