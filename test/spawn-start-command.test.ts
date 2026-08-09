import type { Snapshot } from "@shared/schema";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ENVIRONMENTS } from "../environments.ts";
import { createApi } from "../server/api.ts";
import type { Poller } from "../server/poller.ts";
import type { SpawnOpts } from "../server/spawn.ts";
import { createStorage } from "../server/storage.ts";

const snap: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
const poller: Poller = {
  getSnapshot: () => snap,
  getAttention: () => ({}),
  onSnapshot: () => () => undefined,
  pollOnce: async () => undefined,
  refreshEnv: async () => undefined,
  runClaudeSweepOnce: async () => undefined,
  applyRegistry: () => undefined,
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

describe("POST spawn with a startCommand", () => {
  let tmpDir: string;
  let seen: SpawnOpts[];
  beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "spawn-start-command-")); seen = []; });
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

  it("rejects startCommand and brief sent together", async () => {
    const a = app();
    const tid = await makeBoardAndTask(a);
    const res = await a.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", repo: "repo", brief: "hi", startCommand: "/plan" }),
    });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("writes the start command byte-for-byte, with no preamble", async () => {
    const a = app();
    const tid = await makeBoardAndTask(a);
    await a.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", repo: "repo", startCommand: "/plan" }),
    });
    const p = seen[0]?.briefPath;
    if (p === undefined) throw new Error("expected briefPath");
    expect(readFileSync(p, "utf8")).toBe("/plan");
  });

  it("still prepends the preamble to a plain brief", async () => {
    const a = app();
    const tid = await makeBoardAndTask(a);
    await a.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", repo: "repo", brief: "Continue." }),
    });
    const p = seen[0]?.briefPath;
    if (p === undefined) throw new Error("expected briefPath");
    expect(readFileSync(p, "utf8")).toContain("corral_whoami");
  });

  it("hands spawn a start-command-specific fallback, not the handoff wording", async () => {
    const a = app();
    const tid = await makeBoardAndTask(a);
    await a.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", repo: "repo", startCommand: "/plan" }),
    });
    expect(seen[0]?.briefFallback).toBeDefined();
    expect(seen[0]?.briefFallback).not.toContain("handoff");
  });

  it("refuses a start command for a remote environment", async () => {
    const a = app();
    const tid = await makeBoardAndTask(a);
    const res = await a.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-remote", repo: "repo", startCommand: "/plan" }),
    });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("rejects a whitespace-only start command and one beginning with a dash", async () => {
    const a = app();
    const tid = await makeBoardAndTask(a);
    for (const startCommand of ["   ", "--continue", "- /plan"]) {
      const res = await a.request(`/api/boards/test/tasks/${tid}/spawn`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env: "work-local", repo: "repo", startCommand }),
      });
      expect(res.status, startCommand).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });
});
