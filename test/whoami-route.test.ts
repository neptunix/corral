import type { AttentionMap, Snapshot } from "@shared/schema";
import type { WhoamiResponse } from "@shared/whoami-schema.ts";
import { WhoamiResponseSchema } from "@shared/whoami-schema.ts";
import { mkdtempSync, rmSync } from "node:fs";
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
    tab: "api-refactor-a", workspace: "repo", tabId: "tab1", workspaceId: "ws1",
    sessionId: "11111111-2222-3333-4444-555555555555",
    recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null,
  }],
};
const attention: AttentionMap = {
  "work-local:w1:p1": { state: "blocked", since: 1000, sessionName: "api-refactor", lastLines: "?", captured: true },
};
const poller: Poller = {
  getSnapshot: () => snap,
  getAttention: () => attention,
  onSnapshot: () => () => undefined,
  pollOnce: async () => undefined,
  runClaudeSweepOnce: async () => undefined,
  start: () => undefined,
  stop: () => undefined,
};

describe("GET /api/whoami and /api/attention", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "whoami-route-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("resolves a known pane and returns a schema-valid payload", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    const res = await app.request("/api/whoami?paneId=w1%3Ap1&cwd=%2Frepo");
    expect(res.status).toBe(200);
    const parsed = WhoamiResponseSchema.parse(await res.json());
    if (!parsed.resolved) throw new Error("expected resolved");
    expect(parsed.session.paneId).toBe("w1:p1");
    expect(parsed.task).toBeNull();
  });

  it("returns resolved:false with a reason for an unknown pane (not an HTTP error)", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    const res = await app.request("/api/whoami?paneId=w9%3Ap9&cwd=%2Frepo");
    expect(res.status).toBe(200);
    const body = await res.json() as WhoamiResponse;
    expect(body.resolved).toBe(false);
  });

  it("rejects a paneId that fails the pane charset guard", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    const res = await app.request("/api/whoami?paneId=" + encodeURIComponent("w1;rm -rf /") + "&cwd=%2Frepo");
    expect(res.status).toBe(400);
  });

  it("requires paneId", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    expect((await app.request("/api/whoami?cwd=%2Frepo")).status).toBe(400);
  });

  it("serves the attention map", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    const res = await app.request("/api/attention");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(attention);
  });

  it("finds the card once the session is attached", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    await app.request("/api/boards", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Test" }),
    });
    const { id: tid } = await (await app.request("/api/boards/test/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Refactor the API", status: "todo" }),
    })).json() as { id: string };
    await app.request(`/api/boards/test/tasks/${tid}/attach`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "w1:p1", name: "api-refactor-a" }),
    });

    const parsed = WhoamiResponseSchema.parse(await (await app.request("/api/whoami?paneId=w1%3Ap1&cwd=%2Frepo")).json());
    if (!parsed.resolved) throw new Error("expected resolved");
    expect(parsed.task?.taskId).toBe(tid);
    expect(parsed.task?.columns.length).toBeGreaterThan(0);
    expect(parsed.task?.sessions.filter((s) => s.self)).toHaveLength(1);
  });
});
