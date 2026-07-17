import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { createApi } from "../server/api.ts";
import type { Poller } from "../server/poller.ts";

const local: HerdrEnv = { id: "e-local", label: "L", kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {} };
const remote: HerdrEnv = { id: "e-remote", label: "R", kind: "remote", sshHost: "h", socket: "~/s.sock", herdrBin: "~/herdr", claudeConfigDirs: [], spawnCommand: "claude", repos: {} };
const poller: Poller = {
  getSnapshot: () => ({ envs: {}, sessions: [] }), getAttention: () => ({}),
  onSnapshot: () => () => undefined, pollOnce: () => Promise.resolve(undefined),
  runClaudeSweepOnce: () => Promise.resolve(undefined), start: () => undefined, stop: () => undefined,
};
const ORIGIN = "http://localhost:5173";

function post(app: ReturnType<typeof createApi>, envId: string, o: { origin?: string; file?: boolean }): Promise<Response> {
  const fd = new FormData();
  if (o.file !== false) fd.append("file", new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }));
  const headers: Record<string, string> = {};
  if (o.origin !== undefined) headers.origin = o.origin;
  return Promise.resolve(app.request(`/api/envs/${envId}/uploads`, { method: "POST", headers, body: fd }));
}

describe("POST /api/envs/:env/uploads", () => {
  let root: string;
  let app: ReturnType<typeof createApi>;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "corral-route-"));
    app = createApi({ poller, envs: [local, remote], allowedOrigins: [ORIGIN], uploadRoot: root });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("writes the file and returns a path under uploadRoot (local, good origin)", async () => {
    const res = await post(app, "e-local", { origin: ORIGIN });
    expect(res.status).toBe(200);
    const body = await res.json() as { path: string };
    expect(body.path.startsWith(root + path.sep)).toBe(true);
    expect(existsSync(body.path)).toBe(true);
  });
  it("rejects a disallowed origin with 403", async () => {
    expect((await post(app, "e-local", { origin: "http://evil.example" })).status).toBe(403);
  });
  it("rejects a missing origin with 403", async () => {
    expect((await post(app, "e-local", {})).status).toBe(403);
  });
  it("rejects a remote env with 400", async () => {
    expect((await post(app, "e-remote", { origin: ORIGIN })).status).toBe(400);
  });
  it("rejects an unknown env with 400", async () => {
    expect((await post(app, "nope", { origin: ORIGIN })).status).toBe(400);
  });
  it("rejects a body with no file field with 400", async () => {
    expect((await post(app, "e-local", { origin: ORIGIN, file: false })).status).toBe(400);
  });
});
