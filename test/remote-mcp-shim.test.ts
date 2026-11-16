import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
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
  leftovers(): readonly Msg[];
  exited(): Promise<number | null>;
  readonly proc: ChildProcessWithoutNullStreams;
}

function startShim(socketPath: string): Shim {
  const proc = spawn(process.execPath, [SHIM], {
    env: { ...process.env, CORRAL_MCP_SOCKET: socketPath, HERDR_PANE_ID: "w1:p1", CORRAL_MCP_SHIM_RETRY_MS: "50",
      CORRAL_MCP_SHIM_REPLAY_TIMEOUT_MS: "300" },
  });
  const seen: Msg[] = [];
  const waiters: { want: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    buf += chunk;
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
    leftovers: () => seen,
    exited: () => proc.exitCode === null
      ? new Promise((r) => proc.once("exit", r))
      : Promise.resolve(proc.exitCode),
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

  it("exits once Claude closes stdin, whether corral is connected or not", async () => {
    const listener = await listen();
    const up = startShim(listener.socketPath);
    cleanup.push(() => up.proc.kill());
    await handshake(up);
    up.proc.stdin.end();
    expect(await up.exited()).toBe(0);

    const down = startShim(listener.socketPath);
    cleanup.push(() => down.proc.kill());
    await handshake(down);
    await listener.close();
    down.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await down.next(byId(2));
    down.proc.stdin.end();
    expect(await down.exited()).toBe(0);
  });
});

interface FakeConn {
  readonly lines: Msg[];
  readonly sock: net.Socket;
}

type Respond = (conn: FakeConn, msg: Msg, index: number) => void;

function answer(sock: net.Socket, id: unknown, result: unknown): void {
  sock.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const INIT_RESULT = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } };

function answerAll(conn: FakeConn, msg: Msg): void {
  if (msg.method === "initialize") answer(conn.sock, msg.id, INIT_RESULT);
  else if (msg.method === "tools/list") answer(conn.sock, msg.id, { tools: [] });
}

async function waitFor(cond: () => boolean): Promise<void> {
  while (!cond()) await new Promise((r) => setTimeout(r, 10));
}

// A recording stand-in for corral's listener, so a test controls what each connection answers.
async function fakeCorral(respond: Respond): Promise<{ socketPath: string; conns: FakeConn[] }> {
  const socketPath = path.join(mkdtempSync(path.join(os.tmpdir(), "shim-")), "c.sock");
  const conns: FakeConn[] = [];
  const server = net.createServer((sock) => {
    const conn: FakeConn = { lines: [], sock };
    const index = conns.push(conn) - 1;
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const raw: unknown = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (isMsg(raw)) {
          conn.lines.push(raw);
          respond(conn, raw, index);
        }
        nl = buf.indexOf("\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  cleanup.push(() => {
    for (const c of conns) c.sock.destroy();
    return new Promise((r) => server.close(r));
  });
  return { socketPath, conns };
}

const isReplayId = (m: Msg): boolean => typeof m.id === "string" && m.id.startsWith("corral-shim-replay");

describe("corral MCP shim replay", () => {
  it("replays the handshake ahead of what Claude sent meanwhile, and keeps the replay's reply from Claude", async () => {
    let held: unknown = null;
    const fake = await fakeCorral((conn, msg, index) => {
      if (index === 1 && msg.method === "initialize") held = msg.id;
      else answerAll(conn, msg);
    });
    const shim = startShim(fake.socketPath);
    cleanup.push(() => shim.proc.kill());
    await handshake(shim);

    fake.conns[0]!.sock.destroy();
    await waitFor(() => held !== null);
    shim.send({ jsonrpc: "2.0", id: 5, method: "tools/list" });
    await new Promise((r) => setTimeout(r, 100));
    answer(fake.conns[1]!.sock, held, INIT_RESULT);

    expect(await shim.next(byId(5))).toHaveProperty("result.tools");
    const lines = fake.conns[1]!.lines;
    expect(lines[0]).toEqual({ v: 1, paneId: "w1:p1", cwd: expect.any(String) });
    expect(lines.slice(1).map((m) => m.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(lines[1]).toMatchObject({ id: "corral-shim-replay-1", params: INIT.params });
    expect(shim.leftovers().some(isReplayId)).toBe(false);
    expect(shim.leftovers().some((m) => m.method === "notifications/tools/list_changed")).toBe(true);
  });

  it("retries when corral refuses the replay, failing what Claude sent in the meantime", async () => {
    let refuse: (() => void) | null = null;
    const fake = await fakeCorral((conn, msg, index) => {
      if (index === 1 && msg.method === "initialize") {
        refuse = () => conn.sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "nope" } })}\n`);
      } else answerAll(conn, msg);
    });
    const shim = startShim(fake.socketPath);
    cleanup.push(() => shim.proc.kill());
    await handshake(shim);

    fake.conns[0]!.sock.destroy();
    await waitFor(() => refuse !== null);
    shim.send({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    await new Promise((r) => setTimeout(r, 100));
    refuse!();

    expect(await shim.next(byId(7))).toMatchObject({ error: { code: -32000 } });
    await shim.next((m) => m.method === "notifications/tools/list_changed");
    expect(fake.conns).toHaveLength(3);
    expect(shim.leftovers().some(isReplayId)).toBe(false);
  });

  it("gives up on a replay corral never answers, failing what Claude sent and retrying", async () => {
    const fake = await fakeCorral((conn, msg, index) => {
      if (index !== 1) answerAll(conn, msg);
    });
    const shim = startShim(fake.socketPath);
    cleanup.push(() => shim.proc.kill());
    await handshake(shim);

    fake.conns[0]!.sock.destroy();
    await waitFor(() => fake.conns[1]?.lines.some((m) => m.method === "initialize") === true);
    shim.send({ jsonrpc: "2.0", id: 8, method: "tools/list" });

    expect(await shim.next(byId(8))).toMatchObject({ error: { code: -32000 } });
    await shim.next((m) => m.method === "notifications/tools/list_changed");
    expect(fake.conns).toHaveLength(3);
  });

  it("keeps a multibyte character intact when it is split across chunks, both ways", async () => {
    const TEXT = "Привет, мир";
    const fake = await fakeCorral((conn, msg) => {
      if (msg.method !== "tools/call") {
        answerAll(conn, msg);
        return;
      }
      const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { text: TEXT } })}\n`);
      const cut = bytes.indexOf(Buffer.from("р")) + 1;
      conn.sock.write(bytes.subarray(0, cut));
      setTimeout(() => conn.sock.write(bytes.subarray(cut)), 30);
    });
    const shim = startShim(fake.socketPath);
    cleanup.push(() => shim.proc.kill());
    await handshake(shim);

    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { text: TEXT } })}\n`);
    const cut = bytes.indexOf(Buffer.from("и")) + 1;
    shim.proc.stdin.write(bytes.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 30));
    shim.proc.stdin.write(bytes.subarray(cut));

    expect(await shim.next(byId(9))).toMatchObject({ result: { text: TEXT } });
    expect(fake.conns[0]!.lines.at(-1)).toMatchObject({ params: { text: TEXT } });
  });
});
