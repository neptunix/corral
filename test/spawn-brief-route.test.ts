import type { Snapshot } from "@shared/schema";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BRIEF_MAX_BYTES } from "../config.ts";
import { ENVIRONMENTS } from "../environments.ts";
import { createApi } from "../server/api.ts";
import { composeBrief } from "../server/brief.ts";
import type { Poller } from "../server/poller.ts";
import type { SpawnOpts } from "../server/spawn.ts";
import { createStorage } from "../server/storage.ts";

const snap: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
const poller: Poller = {
  getSnapshot: () => snap,
  getAttention: () => ({}),
  onSnapshot: () => () => undefined,
  pollOnce: async () => undefined,
  runClaudeSweepOnce: async () => undefined,
  start: () => undefined,
  stop: () => undefined,
};

async function makeBoardAndTask(app: ReturnType<typeof createApi>): Promise<string> {
  await app.request("/api/boards", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Test" }),
  });
  const { id } = await (await app.request("/api/boards/test/tasks", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Refactor the API", status: "todo" }),
  })).json() as { id: string };
  return id;
}

describe("POST spawn with a brief", () => {
  let tmpDir: string;
  let seen: SpawnOpts[];
  beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "spawn-brief-")); seen = []; });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  function app() {
    return createApi({
      poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
      briefRoot: path.join(tmpDir, "briefs"),
      spawn: async (opts) => {
        seen.push(opts);
        return {
          paneId: "w1:p2", tabId: "t2", workspaceId: "ws1", workspaceLabel: "repo",
          tabLabel: "refactor-the-api-a", cwdSnapshot: "/repo", idempotent: false,
        };
      },
    });
  }

  it("writes the brief and hands spawn a path, not the text", async () => {
    const a = app();
    const tid = await makeBoardAndTask(a);
    const res = await a.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", repo: "repo", brief: "Continue the refactor." }),
    });
    expect(res.status).toBe(200);
    const briefPath = seen[0]?.briefPath;
    expect(typeof briefPath).toBe("string");
    if (briefPath === undefined) throw new Error("expected briefPath");
    expect(path.dirname(briefPath)).toBe(path.join(tmpDir, "briefs")); // the injected root, not $CORRAL_HOME
    const written = readFileSync(briefPath, "utf8");
    expect(written).toContain("corral_whoami");
    expect(written).toContain("Continue the refactor.");
  });

  it("spawns without a briefPath when no brief is sent", async () => {
    const a = app();
    const tid = await makeBoardAndTask(a);
    await a.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", repo: "repo" }),
    });
    expect(seen[0]?.briefPath).toBeUndefined();
  });

  it("rejects an over-cap brief with 413 and does not spawn", async () => {
    const a = app();
    const tid = await makeBoardAndTask(a);
    const res = await a.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", repo: "repo", brief: "x".repeat(20000) }),
    });
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("accepts a brief landing exactly at the cap and rejects one byte more", async () => {
    const a = app();
    const tid = await makeBoardAndTask(a);
    const overhead = composeBrief("").length; // preamble + two newlines, all ASCII (1 byte per char)
    const atCap = "x".repeat(BRIEF_MAX_BYTES - overhead);
    const ok = await a.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", repo: "repo", brief: atCap }),
    });
    expect(ok.status).toBe(200);
    const over = await a.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", repo: "repo", brief: `${atCap}y` }),
    });
    expect(over.status).toBe(413);
    expect(seen).toHaveLength(1); // only the at-cap brief spawned — the cap charges the preamble too
  });

  it("refuses a brief for a remote environment with 400 and does not spawn", async () => {
    const a = app();
    const tid = await makeBoardAndTask(a);
    const res = await a.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-remote", repo: "repo", brief: "hi" }),
    });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("still allows a brief-less spawn into a remote environment", async () => {
    const a = app();
    const tid = await makeBoardAndTask(a);
    const res = await a.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-remote", repo: "repo" }),
    });
    expect(res.status).toBe(200);
  });
});
