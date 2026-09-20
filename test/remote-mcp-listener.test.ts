import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { startEnvListener } from "../server/remote-mcp/listener.ts";
import type { PinnedDeps } from "../server/remote-mcp/pinned-client.ts";

// The listener binds under CORRAL_HOME, which test/setup.ts already points at a temp directory —
// so these tests never touch a real corral home, and never collide with a running server.
const env: Extract<HerdrEnv, { kind: "remote" }> = {
  id: "envA", label: "Env A", kind: "remote", sshHost: "host1", socket: "/s.sock", herdrBin: "/herdr",
  mcpSocket: "/home/u/.corral/mcp.sock", claudeConfigDirs: [], spawnCommand: "claude", repos: {},
};

const poller = {
  getSnapshot: () => ({ sessions: [], envs: {}, at: 0 }),
  refreshEnv: () => Promise.resolve(),
};

const deps: PinnedDeps = {
  env, envs: [env], poller, storage: undefined,
  paneLookup: () => Promise.resolve(null),
};

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

/** Read whole JSON-RPC lines off the socket until one satisfies `want`, or the socket closes. */
function collect(sock: net.Socket, want: (msg: unknown) => boolean, timeoutMs = 4000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => { reject(new Error("timed out waiting for a reply")); }, timeoutMs);
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() !== "") {
          const msg: unknown = JSON.parse(line);
          if (want(msg)) {
            clearTimeout(timer);
            resolve(msg);
            return;
          }
        }
        nl = buf.indexOf("\n");
      }
    });
    sock.on("close", () => { clearTimeout(timer); reject(new Error("socket closed before a reply")); });
  });
}

function hasResultId(msg: unknown, id: number): boolean {
  return typeof msg === "object" && msg !== null && "id" in msg && msg.id === id && "result" in msg;
}

const started: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const l of started.splice(0)) await l.close();
});

describe("remote MCP listener", () => {
  it("handshakes when the preamble and the first request arrive in ONE chunk", async () => {
    const listener = await startEnvListener(deps, "http://127.0.0.1:1");
    started.push(listener);
    const sock = net.createConnection(listener.socketPath);
    await new Promise<void>((r) => sock.once("connect", () => { r(); }));

    // The hazard: a shim writes its preamble and immediately pipes, so these almost always share a
    // TCP segment. A reader that consumes past the newline swallows `initialize` and the handshake
    // hangs with no error anywhere.
    sock.write(`${JSON.stringify({ v: 1, paneId: "w1:p1", cwd: "/repo" })}\n${JSON.stringify(INIT)}\n`);

    const reply = await collect(sock, (m) => hasResultId(m, 1));
    expect(reply).toBeDefined();
    sock.destroy();
  });

  it("handshakes when the preamble line is split mid-JSON across chunks", async () => {
    const listener = await startEnvListener(deps, "http://127.0.0.1:1");
    started.push(listener);
    const sock = net.createConnection(listener.socketPath);
    await new Promise<void>((r) => sock.once("connect", () => { r(); }));

    const preamble = JSON.stringify({ v: 1, paneId: "w1:p1", cwd: "/repo" });
    sock.write(preamble.slice(0, 10));
    await new Promise((r) => setTimeout(r, 20));
    sock.write(`${preamble.slice(10)}\n`);
    await new Promise((r) => setTimeout(r, 20));
    sock.write(`${JSON.stringify(INIT)}\n`);

    const reply = await collect(sock, (m) => hasResultId(m, 1));
    expect(reply).toBeDefined();
    sock.destroy();
  });

  it("offers the reduced tool set — no corral_fleet", async () => {
    const listener = await startEnvListener(deps, "http://127.0.0.1:1");
    started.push(listener);
    const sock = net.createConnection(listener.socketPath);
    await new Promise<void>((r) => sock.once("connect", () => { r(); }));
    sock.write(`${JSON.stringify({ v: 1, paneId: "w1:p1", cwd: "/repo" })}\n${JSON.stringify(INIT)}\n`);
    await collect(sock, (m) => hasResultId(m, 1));
    sock.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);

    const reply = await collect(sock, (m) => hasResultId(m, 2));
    const names = JSON.stringify(reply);
    expect(names).toContain("corral_whoami");
    expect(names).toContain("corral_spawn");
    // A fleet-wide view of every session — including panes on the corral host — is not a remote
    // session's business (ADR 0009).
    expect(names).not.toContain("corral_fleet");
    sock.destroy();
  });

  it("drops a connection whose preamble is not valid", async () => {
    const listener = await startEnvListener(deps, "http://127.0.0.1:1");
    started.push(listener);
    const sock = net.createConnection(listener.socketPath);
    await new Promise<void>((r) => sock.once("connect", () => { r(); }));
    sock.write("not json at all\n");
    await new Promise<void>((r) => sock.once("close", () => { r(); }));
    expect(sock.destroyed).toBe(true);
  });

  it("drops a connection that floods the preamble with no newline", async () => {
    const listener = await startEnvListener(deps, "http://127.0.0.1:1");
    started.push(listener);
    const sock = net.createConnection(listener.socketPath);
    await new Promise<void>((r) => sock.once("connect", () => { r(); }));
    // Unbounded buffering here would be reachable from the other side of the trust boundary.
    sock.write("x".repeat(9000));
    await new Promise<void>((r) => sock.once("close", () => { r(); }));
    expect(sock.destroyed).toBe(true);
  });

  it("stays quiet when a peer connects and hangs up without speaking", async () => {
    // corral's own tunnel probe does exactly this, every tick, to tell a live forward from a
    // leftover socket file. Treating it as a fault would fill the log with one error per tick.
    const listener = await startEnvListener(deps, "http://127.0.0.1:1");
    started.push(listener);
    const sock = net.createConnection(listener.socketPath);
    await new Promise<void>((r) => sock.once("connect", () => { r(); }));
    sock.destroy();
    await new Promise<void>((r) => sock.once("close", () => { r(); }));
    expect(sock.destroyed).toBe(true);
  });

  it("closes established sessions when the listener closes, instead of waiting for them", async () => {
    // These connections are long-lived by design — one per Claude session — so a close that only
    // stops accepting would never settle, and a shutdown would hang on the first live session.
    const listener = await startEnvListener(deps, "http://127.0.0.1:1");
    const sock = net.createConnection(listener.socketPath);
    await new Promise<void>((r) => sock.once("connect", () => { r(); }));
    sock.write(`${JSON.stringify({ v: 1, paneId: "w1:p1", cwd: "/repo" })}\n${JSON.stringify(INIT)}\n`);
    await collect(sock, (m) => hasResultId(m, 1));

    const closed = new Promise<void>((r) => sock.once("close", () => { r(); }));
    await listener.close();
    await closed;
    expect(sock.destroyed).toBe(true);
  });

  it("releases the connection when the peer goes away, and keeps serving the next one", async () => {
    const listener = await startEnvListener(deps, "http://127.0.0.1:1");
    started.push(listener);
    for (const _ of [0, 1]) {
      const sock = net.createConnection(listener.socketPath);
      await new Promise<void>((r) => sock.once("connect", () => { r(); }));
      sock.write(`${JSON.stringify({ v: 1, paneId: "w1:p1", cwd: "/repo" })}\n${JSON.stringify(INIT)}\n`);
      await collect(sock, (m) => hasResultId(m, 1));
      sock.end();
      await new Promise<void>((r) => sock.once("close", () => { r(); }));
    }
    expect(true).toBe(true);
  });
});
