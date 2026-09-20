import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { createApi } from "../server/api.ts";
import type { Poller } from "../server/poller.ts";

const poller: Poller = {
  getSnapshot: () => ({ envs: {}, sessions: [] }), getAttention: () => ({}),
  onSnapshot: () => () => undefined, pollOnce: () => Promise.resolve(undefined),
  refreshEnv: () => Promise.resolve(undefined),
  runClaudeSweepOnce: () => Promise.resolve(undefined), start: () => undefined, stop: () => undefined,
  applyRegistry: () => undefined,
};

const remote = (id: string): HerdrEnv => ({ id, label: id, kind: "remote", sshHost: "host1", socket: "~/s.sock", herdrBin: "~/herdr", claudeConfigDirs: ["/cfg"], spawnCommand: "claude", repos: {} });

describe("POST /api/theme", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "corral-theme-route-"));
    await fs.mkdir(path.join(dir, "themes"));
    file = path.join(dir, "themes", "corral.json");
    await fs.writeFile(file, JSON.stringify({ base: "dark" }), "utf8");
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  const post = (app: ReturnType<typeof createApi>, mode: string): Promise<Response> =>
    Promise.resolve(app.request("/api/theme", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) }));

  it("syncs local dirs and every remote env, summing the updates", async () => {
    const local: HerdrEnv = { id: "l", label: "L", kind: "local", claudeConfigDirs: [dir], spawnCommand: "claude", repos: {} };
    const seen: string[] = [];
    const app = createApi({
      poller, envs: [local, remote("r1"), remote("r2")],
      syncRemoteTheme: (env, mode) => { seen.push(`${env.id}:${mode}`); return Promise.resolve(1); },
    });
    const res = await post(app, "light");
    expect(await res.json()).toEqual({ ok: true, updated: 3 });
    expect(seen.sort()).toEqual(["r1:light", "r2:light"]);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ base: "light" });
  });

  it("does not fail the toggle when a remote cannot be reached", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const local: HerdrEnv = { id: "l", label: "L", kind: "local", claudeConfigDirs: [dir], spawnCommand: "claude", repos: {} };
    const app = createApi({
      poller, envs: [local, remote("r1")],
      syncRemoteTheme: () => Promise.reject(new Error("remote theme read failed (ssh exit 255)")),
    });
    const res = await post(app, "light");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: 1 });
  });

  it("rejects a mode that is not light or dark", async () => {
    const app = createApi({ poller, envs: [remote("r1")], syncRemoteTheme: () => Promise.resolve(0) });
    expect((await post(app, "sepia")).status).toBe(400);
  });
});
