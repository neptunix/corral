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
  refreshEnv: async () => undefined,
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

  // The regression: whoami used to answer purely from the cached snapshot, which the cheap poll
  // only rebuilds every 30s. A pane created seconds ago is absent from it — and that is the FIRST
  // thing a spawned session hits, because its brief tells it to call corral_whoami before anything
  // else. The route must re-poll on the miss and answer from the fresh listing instead of reporting
  // the caller's own live pane as nonexistent.
  it("re-polls local environments when the pane is missing, and resolves it on the retry", async () => {
    let latest: Snapshot = { envs: snap.envs, sessions: [] };
    const refreshed: string[] = [];
    const lagging: Poller = {
      ...poller,
      getSnapshot: () => latest,
      refreshEnv: async (envId) => {
        refreshed.push(envId);
        latest = snap; // the pane shows up only once the environment is actually re-listed
      },
    };
    const app = createApi({ poller: lagging, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    const parsed = WhoamiResponseSchema.parse(
      await (await app.request("/api/whoami?paneId=w1%3Ap1&cwd=%2Frepo")).json(),
    );
    if (!parsed.resolved) throw new Error("expected the refresh to resolve the pane");
    expect(parsed.session.paneId).toBe("w1:p1");
    expect(refreshed).toContain("work-local");
  });

  // Re-polling cannot help a pane whose Claude has not registered with herdr yet: the snapshot is
  // built from `herdr agent list`, so such a pane is invisible there no matter how fresh the poll.
  // That is the exact state a spawned session is in when its brief tells it to call corral_whoami
  // first. The route must fall back to asking herdr about the pane itself.
  describe("pane-level fallback (no agent registered yet)", () => {
    const emptySnap: Snapshot = { envs: snap.envs, sessions: [] };
    const paneOnly: Poller = { ...poller, getSnapshot: () => emptySnap };
    const pane = {
      paneId: "w1:p1", tabId: "tab1", tabLabel: "api-refactor-a",
      workspaceId: "ws1", workspaceLabel: "repo", cwd: "/repo",
    };

    it("resolves from the pane, with metrics absent rather than the session missing", async () => {
      const app = createApi({
        poller: paneOnly, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
        paneIdentityFn: (_e, id) => Promise.resolve(id === "w1:p1" ? pane : null),
      });
      const parsed = WhoamiResponseSchema.parse(
        await (await app.request("/api/whoami?paneId=w1%3Ap1&cwd=%2Frepo")).json(),
      );
      if (!parsed.resolved) throw new Error("expected the pane fallback to resolve");
      expect(parsed.session.paneId).toBe("w1:p1");
      expect(parsed.session.tabLabel).toBe("api-refactor-a");
      expect(parsed.session.cwd).toBe("/repo");
      // Not yet known — and that is the point: absent metrics beat an absent session.
      expect(parsed.session.sessionId).toBeNull();
      expect(parsed.session.model).toBeNull();
      expect(parsed.session.ctxPct).toBeNull();
      expect(parsed.session.status).toBe("starting");
    });

    // The payoff: a spawned session finds the card it was spawned onto without waiting for herdr,
    // because a link with no session id binds on env + paneId alone.
    it("finds the card from a session-less link", async () => {
      const app = createApi({
        poller: paneOnly, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
        paneIdentityFn: () => Promise.resolve(pane),
      });
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

      const parsed = WhoamiResponseSchema.parse(
        await (await app.request("/api/whoami?paneId=w1%3Ap1&cwd=%2Frepo")).json(),
      );
      if (!parsed.resolved) throw new Error("expected resolved");
      expect(parsed.task?.taskId).toBe(tid);
      expect(parsed.task?.columns.length).toBeGreaterThan(0);
      expect(parsed.task?.sessions.filter((s) => s.self)).toHaveLength(1);
    });

    it("is not consulted when the snapshot already resolves the caller", async () => {
      let calls = 0;
      const app = createApi({
        poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
        paneIdentityFn: () => { calls += 1; return Promise.resolve(pane); },
      });
      const res = await app.request("/api/whoami?paneId=w1%3Ap1&cwd=%2Frepo");
      expect(res.status).toBe(200);
      expect(calls).toBe(0);
    });

    it("reports a pane herdr does not know as genuinely absent", async () => {
      const app = createApi({
        poller: paneOnly, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
        paneIdentityFn: () => Promise.resolve(null),
      });
      const body = await (await app.request("/api/whoami?paneId=w9%3Ap9")).json() as WhoamiResponse;
      expect(body.resolved).toBe(false);
      if (body.resolved) throw new Error("unreachable");
      expect(body.reason).toContain("no pane w9:p9");
    });
  });

  it("re-polls once per local environment and no more — the miss path stays bounded", async () => {
    let calls = 0;
    const empty: Poller = {
      ...poller,
      getSnapshot: () => ({ envs: snap.envs, sessions: [] }),
      refreshEnv: async () => { calls += 1; },
    };
    const app = createApi({
      poller: empty, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
      paneIdentityFn: () => Promise.resolve(null),
    });
    const body = await (await app.request("/api/whoami?paneId=w9%3Ap9&cwd=%2Frepo")).json() as WhoamiResponse;
    expect(body.resolved).toBe(false);
    expect(calls).toBe(ENVIRONMENTS.filter((e) => e.kind === "local").length);
  });

  // An ambiguous match already found real rows. Escalating it to the pane lookup would replace them
  // with a synthesized, metric-less row AND swallow the ambiguity the operator needs to see.
  it("does not escalate an ambiguous match to the pane lookup", async () => {
    const dup = "dup:p1";
    const twoEnvs = ENVIRONMENTS.filter((e) => e.kind === "local").slice(0, 2);
    if (twoEnvs.length < 2) return; // fixture has a single local env — nothing to disambiguate
    const base = snap.sessions[0];
    if (base === undefined) throw new Error("fixture must carry a session row");
    let calls = 0;
    const ambiguous: Poller = {
      ...poller,
      getSnapshot: () => ({
        envs: snap.envs,
        sessions: twoEnvs.map((e) => ({ ...base, env: e.id, paneId: dup, cwd: "/other" })),
      }),
    };
    const app = createApi({
      poller: ambiguous, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
      paneIdentityFn: () => { calls += 1; return Promise.resolve(null); },
    });
    const body = await (await app.request(`/api/whoami?paneId=${encodeURIComponent(dup)}&cwd=%2Frepo`)).json() as WhoamiResponse;
    expect(body.resolved).toBe(false);
    if (body.resolved) throw new Error("unreachable");
    expect(body.reason).toContain("ambiguous");
    expect(calls).toBe(0);
  });

  it("distinguishes a missing paneId from a malformed one", async () => {
    const app = createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
    const bad = await app.request("/api/whoami?paneId=" + encodeURIComponent("w1;rm -rf /"));
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain("malformed");
    const missing = await app.request("/api/whoami");
    expect(JSON.stringify(await missing.json())).toContain("required");
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
