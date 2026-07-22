import { StreamFrameSchema } from "@shared/board-schema.ts";
import type { BoardState } from "@shared/board-schema.ts";
import type { AttentionMap, Snapshot } from "@shared/schema";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ENVIRONMENTS } from "../environments.ts";
import { createApi } from "../server/api.ts";
import type { Poller } from "../server/poller.ts";
import { createStorage } from "../server/storage.ts";

const snap: Snapshot = {
  envs: { "work-local": { reachable: true } },
  sessions: [{ env: "work-local", paneId: "w1-1", status: "working", agent: "claude", cwd: "/x", tab: "t", workspace: "w", sessionId: null, recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null }],
};
const poller: Poller = {
  getSnapshot: () => snap,
  getAttention: () => ({}),
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  onSnapshot: () => () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  pollOnce: async () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  runClaudeSweepOnce: async () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  start: () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  stop: () => {},
};
// eslint-disable-next-line @typescript-eslint/require-await
const okRead = async () => ({ text: "", ctxPct: null, model: null, sessionName: null });

describe("api", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "api-test-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("enriches attached-session live data with recap + statusline and emits accounts", async () => {
    // Arrange: a board with one task linked to (env,paneId) that resolves to a live row carrying a
    // statusline with an account.
    const liveSnapshot: Snapshot = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        env: "work-local", paneId: "w1-1", status: "working", agent: "claude", cwd: "/c",
        tab: "t", workspace: "w", sessionId: "sid", recap: "did X", recapAt: 5,
        recapStatus: "ok", statusline: { v: 1, captured_at: 9, session_id: "sid", session_name: null, name_source: null,
          account: { uuid: "u1", email: "a@b.c", org: "O", tier: "t" }, model: "Opus", model_id: null,
          ctx: { pct: 42, tokens: null, window: null }, cost: { usd: null, lines_added: null, lines_removed: null },
          rate: { five_hour: { used_percentage: 31, resets_at: 1 }, seven_day: null }, effort: null,
          thinking: null, cc_version: null }, statuslineStatus: "ok",
      }],
    };
    const app = createApi({
      poller: { ...poller, getSnapshot: () => liveSnapshot },
      envs: ENVIRONMENTS,
      storage: createStorage(tmpDir),
    });
    await app.request("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }) });
    const { id: tid } = await (await app.request("/api/boards/test/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T", status: "todo" }),
    })).json() as { id: string };
    await app.request(`/api/boards/test/tasks/${tid}/attach`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", paneId: "w1-1" }),
    });

    const state = await (await app.request("/api/state?board=test")).json() as BoardState;
    const enrichedLive = state.tasks[0]?.sessions[0]?.live;
    expect(enrichedLive?.recap).toBe("did X");
    expect(enrichedLive?.model).toBe("Opus");
    expect(enrichedLive?.ctxPct).toBe("42");
    expect(state.accounts[0]?.fiveHour?.used_percentage).toBe(31);
  });

  it("GET /api/stream with no board sends frames the client's StreamFrameSchema parses, carrying attention", async () => {
    // The no-board stream used to send a bare Snapshot, which the client's schema
    // rejects — every frame dropped, attention feed + badge frozen on the Unassigned view.
    const attention: AttentionMap = {
      "work-local:w1-1": { state: "blocked", since: 100, sessionName: "s", lastLines: "", captured: false },
    };
    const res = await createApi({ poller: { ...poller, getAttention: () => attention }, envs: ENVIRONMENTS })
      .request("/api/stream");
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    expect(dataLine).toBeDefined();
    const frame: unknown = JSON.parse(dataLine!.slice("data:".length).trim());
    const parsed = StreamFrameSchema.safeParse(frame);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.attention).toEqual(attention);
      expect("board" in parsed.data).toBe(false); // the no-board frame is the GlobalState shape
    }
  });

  it("GET /api/state returns the snapshot", async () => {
    const res = await createApi({ poller, envs: ENVIRONMENTS }).request("/api/state");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(snap);
  });

  it("GET /read validates the env", async () => {
    const res = await createApi({ poller, envs: ENVIRONMENTS, read: okRead }).request("/api/sessions/bogus/w1-1/read");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation");
  });

  it("GET /read validates the paneId format", async () => {
    const res = await createApi({ poller, envs: ENVIRONMENTS, read: okRead }).request("/api/sessions/work-local/bad%20id!/read");
    expect(res.status).toBe(400);
  });

  it("GET /read returns the pane buffer", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const read = vi.fn(async () => ({ text: "hi", ctxPct: "5", model: "Opus", sessionName: "s" }));
    const res = await createApi({ poller, envs: ENVIRONMENTS, read }).request("/api/sessions/work-local/w1-1/read?lines=20");
    expect(await res.json()).toEqual({ text: "hi", ctxPct: "5", model: "Opus", sessionName: "s" });
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ id: "work-local" }), "w1-1", 20);
  });
});
