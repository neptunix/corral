import type { Snapshot } from "@shared/schema";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ENVIRONMENTS } from "../environments.ts";
import { createApi } from "../server/api.ts";
import type { Poller } from "../server/poller.ts";
import { createStorage } from "../server/storage.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const snap: Snapshot = {
  envs: { "work-local": { reachable: true } },
  sessions: [{
    env: "work-local", paneId: "w1:p1", status: "working", agent: "claude", cwd: "/repo",
    tab: "api-refactor-a", workspace: "repo", tabId: "tab1", workspaceId: "ws1",
    sessionId: SID, recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null,
  }],
};
const poller: Poller = {
  getSnapshot: () => snap,
  getAttention: () => ({}),
  onSnapshot: () => () => undefined,
  pollOnce: async () => undefined,
  refreshEnv: async () => undefined,
  runClaudeSweepOnce: async () => undefined,
  start: () => undefined,
  stop: () => undefined,
};

async function boardWithLink(app: ReturnType<typeof createApi>): Promise<string> {
  await app.request("/api/boards", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Test" }),
  });
  const { id } = await (await app.request("/api/boards/test/tasks", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Refactor the API", status: "todo" }),
  })).json() as { id: string };
  await app.request(`/api/boards/test/tasks/${id}/attach`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ env: "work-local", paneId: "w1:p1", name: "api-refactor-a" }),
  });
  return id;
}

describe("close with ?deferred=1", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "close-deferred-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("responds while the pane close is still pending (long defer)", async () => {
    let closed = 0;
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
      closePaneFn: async () => { closed += 1; },
      closeDeferMs: 60_000, // deliberately huge; the impl unref()s it, so it cannot hold the worker open
    });
    const tid = await boardWithLink(app);
    const res = await app.request(
      `/api/boards/test/tasks/${tid}/sessions/work-local/${encodeURIComponent("w1:p1")}/close?deferred=1`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scheduled: true });
    expect(closed).toBe(0);
  });

  it("actually runs the scheduled close (short defer)", async () => {
    let release = (): void => undefined;
    const ran = new Promise<void>((resolve) => { release = resolve; });
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
      closePaneFn: async () => { release(); },
      closeDeferMs: 1,
    });
    const tid = await boardWithLink(app);
    const res = await app.request(
      `/api/boards/test/tasks/${tid}/sessions/work-local/${encodeURIComponent("w1:p1")}/close?deferred=1`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    await ran; // resolves only if the deferred closePaneFn fired
  });

  // A rejected `closePaneFn` inside the scheduled `setTimeout` is the only thing standing between a
  // failed self-close and an unhandled rejection in a bare timer callback (server/api.ts ~774-779).
  // Prove it is actually caught: the route must still have responded 200 earlier, and the rejection
  // must surface only as a logged warning — never as an unhandled rejection that would fail this test.
  it("catches a rejected deferred close instead of leaving an unhandled rejection", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
      closePaneFn: async () => { throw new Error("boom: pane close failed"); },
      closeDeferMs: 1,
    });
    const tid = await boardWithLink(app);
    const res = await app.request(
      `/api/boards/test/tasks/${tid}/sessions/work-local/${encodeURIComponent("w1:p1")}/close?deferred=1`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scheduled: true });
    // Poll briefly for the warn call rather than a fixed sleep: the timer + rejection are both real
    // async work, not something we control the scheduling of.
    for (let i = 0; i < 50 && warnSpy.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("boom: pane close failed"));
    warnSpy.mockRestore();
  });

  it("runs every ownership guard BEFORE scheduling (unlinked pane still 404s)", async () => {
    let closed = 0;
    const app = createApi({
      poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
      closePaneFn: async () => { closed += 1; },
      closeDeferMs: 1,
    });
    const tid = await boardWithLink(app);
    const res = await app.request(
      `/api/boards/test/tasks/${tid}/sessions/work-local/${encodeURIComponent("w9:p9")}/close?deferred=1`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(closed).toBe(0);
  });
});
