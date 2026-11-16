import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { startEnvListener, type RemoteMcpListener } from "../server/remote-mcp/listener.ts";
import type { PinnedDeps } from "../server/remote-mcp/pinned-client.ts";

const SHIM = path.resolve(import.meta.dirname, "../scripts/corral-mcp-shim.mjs");

const env: Extract<HerdrEnv, { kind: "remote" }> = {
  id: "shimEnv", label: "Shim Env", kind: "remote", sshHost: "host1", socket: "/s.sock", herdrBin: "/herdr",
  mcpSocket: "/home/u/.corral/mcp.sock", claudeConfigDirs: [], spawnCommand: "claude", repos: {},
};

const deps: PinnedDeps = {
  env, envs: [env], poller: { getSnapshot: () => ({ sessions: [], envs: {}, at: 0 }), refreshEnv: () => Promise.resolve() },
  storage: undefined, paneLookup: () => Promise.resolve(null),
};

type Msg = Record<string, unknown>;

function isMsg(v: unknown): v is Msg {
  return typeof v === "object" && v !== null;
}

interface Shim {
  send(msg: Msg): void;
  next(want: (m: Msg) => boolean): Promise<Msg>;
  readonly proc: ChildProcessWithoutNullStreams;
}

function startShim(socketPath: string): Shim {
  const proc = spawn(process.execPath, [SHIM], {
    env: { ...process.env, CORRAL_MCP_SOCKET: socketPath, HERDR_PANE_ID: "w1:p1", CORRAL_MCP_SHIM_RETRY_MS: "50" },
  });
  const seen: Msg[] = [];
  const waiters: { want: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  let buf = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const raw: unknown = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (isMsg(raw)) {
        const i = waiters.findIndex((w) => w.want(raw));
        const waiter = i === -1 ? undefined : waiters.splice(i, 1)[0];
        if (waiter === undefined) seen.push(raw);
        else waiter.resolve(raw);
      }
      nl = buf.indexOf("\n");
    }
  });
  return {
    proc,
    send: (msg) => proc.stdin.write(`${JSON.stringify(msg)}\n`),
    next: (want) => {
      const i = seen.findIndex(want);
      if (i !== -1) return Promise.resolve(seen.splice(i, 1)[0] ?? {});
      return new Promise((resolve) => waiters.push({ want, resolve }));
    },
  };
}

const byId = (id: number) => (m: Msg): boolean => m.id === id;
const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function listen(d: PinnedDeps = deps): Promise<RemoteMcpListener> {
  const l = await startEnvListener(d, "http://127.0.0.1:1");
  cleanup.push(() => l.close());
  return l;
}

async function handshake(shim: Shim): Promise<void> {
  shim.send(INIT);
  expect(await shim.next(byId(1))).toHaveProperty("result");
  shim.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

describe("corral MCP shim", () => {
  it("survives corral going away and coming back without Claude restarting it", async () => {
    let listener = await listen();
    const shim = startShim(listener.socketPath);
    cleanup.push(() => shim.proc.kill());
    await handshake(shim);

    await listener.close();
    shim.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(await shim.next(byId(2))).toMatchObject({ error: { code: -32000 } });
    expect(shim.proc.exitCode).toBeNull();

    listener = await listen();
    await shim.next((m) => m.method === "notifications/tools/list_changed");
    shim.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const listed = await shim.next(byId(3));
    expect(listed).toHaveProperty("result.tools");
  });

  it("fails a request that was in flight when the connection dropped", async () => {
    const listener = await listen({ ...deps, paneLookup: () => new Promise(() => undefined) });
    const shim = startShim(listener.socketPath);
    cleanup.push(() => shim.proc.kill());
    await handshake(shim);

    shim.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "corral_whoami", arguments: {} } });
    await new Promise((r) => setTimeout(r, 200));
    await listener.close();
    expect(await shim.next(byId(2))).toMatchObject({ error: { code: -32000 } });
  });

  it("exits with a clear error when corral is not there at startup", async () => {
    const shim = startShim(path.join(path.dirname(SHIM), "no-such.sock"));
    let stderr = "";
    shim.proc.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    const code = await new Promise<number | null>((r) => shim.proc.once("exit", r));
    expect(code).toBe(1);
    expect(stderr).toContain("corral is not connected");
  });
});
