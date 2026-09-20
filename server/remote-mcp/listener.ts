import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";

import { createPinnedClient, type PinnedDeps } from "./pinned-client.ts";
import { parsePreamble, PREAMBLE_MAX_BYTES } from "./preamble.ts";
import { CORRAL_HOME } from "../../config.ts";
import { createIdentity } from "../../mcp/identity.ts";
import { ORIENTATION } from "../../mcp/orientation.ts";
import { registerSelfTool } from "../../mcp/tools/self.ts";
import { registerSessionTools } from "../../mcp/tools/session.ts";
import { registerTaskTools } from "../../mcp/tools/task.ts";

/** Where the per-environment listeners live. 0700, so only the account running corral can connect —
 *  the local half of the same per-user rule sshd enforces on the remote end of the forward. */
export const MCP_SOCKET_DIR = path.join(CORRAL_HOME, "mcp");

export function localSocketPath(envId: string): string {
  return path.join(MCP_SOCKET_DIR, `${envId}.sock`);
}

/** A peer that connects and then says nothing holds a socket and a buffer. Drop it. */
const PREAMBLE_TIMEOUT_MS = 15_000;
/** Claude opens one connection per session, so this is far above any honest load; it exists so a
 *  looping peer cannot exhaust file descriptors for the whole corral process. */
const MAX_CONNECTIONS = 64;

/**
 * One MCP server per accepted connection, with its environment fixed by WHICH listener accepted it.
 *
 * The tool set is reduced on purpose (ADR 0009): `corral_fleet` is absent, because it is a
 * fleet-wide view of every session including panes on the corral host, and a remote session's
 * business is its own card. The tools that DO act — spawn and close — are pinned to this
 * environment, so the higher-trust side of the boundary is never a target.
 */
function serveConnection(conn: net.Socket, deps: PinnedDeps, baseUrl: string): void {
  let buf = Buffer.alloc(0);
  let started = false;

  const fail = (reason: string): void => {
    // The peer is a pipe into Claude's stdio, so there is no protocol-level way to explain this that
    // Claude would render; the line is for the operator reading corral's own stderr.
    console.error(`[remote-mcp] ${deps.env.id}: dropping connection — ${reason}`);
    conn.destroy();
  };

  const timer = setTimeout(() => {
    if (!started) fail("no preamble within the deadline");
  }, PREAMBLE_TIMEOUT_MS);
  timer.unref();

  const start = (line: string, rest: Buffer): void => {
    const parsed = parsePreamble(line);
    if (!parsed.ok) {
      fail(parsed.reason);
      return;
    }
    // The transport reads from `through`, not from the socket, so bytes that arrived in the SAME
    // chunk as the preamble are not lost — they are pushed ahead of the pipe.
    const through = new PassThrough();
    if (rest.length > 0) through.write(rest);
    conn.pipe(through);

    const client = createPinnedClient(baseUrl, deps);
    const identity = createIdentity(client, {
      paneId: parsed.preamble.paneId,
      cwd: parsed.preamble.cwd,
      // Never a hint here: this connection's environment is already asserted by the listener.
      socket: null,
    });
    const server = new McpServer({ name: "corral", version: "0.1.0" }, { instructions: ORIENTATION });
    registerSelfTool(server, identity);
    registerTaskTools(server, { client, identity });
    registerSessionTools(server, { client, identity, envScope: deps.env.id });

    const transport = new StdioServerTransport(through, conn);
    // The SDK's stdio transport was written for a process's own stdin/stdout, which never close while
    // the process lives: it listens for "data" and "error" only, and its own close() merely pauses the
    // reader. Wired to a SOCKET that is a peer on the other side of a trust boundary, that means a
    // peer disconnecting — every /exit, every restart, every dropped tunnel — would leave this
    // server, its tools and their closures reachable from the listener forever, in a process that is
    // meant to run for weeks. So the socket's lifecycle drives the server's, explicitly and once.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      through.end();
      void server.close().catch(() => undefined);
      conn.destroy();
    };
    conn.on("close", release);
    conn.on("end", release);
    conn.on("error", release);
    transport.onclose = release;
    transport.onerror = release;

    server.connect(transport).catch((err: unknown) => {
      console.error(`[remote-mcp] ${deps.env.id}: session failed — ${err instanceof Error ? err.message : String(err)}`);
      release();
    });
    conn.resume();
  };

  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl === -1) {
      if (buf.length > PREAMBLE_MAX_BYTES) fail("preamble exceeded its size limit with no newline");
      return;
    }
    // Both synchronous, and inside the handler: node emits no further "data" before this returns,
    // so nothing is read twice and nothing is dropped between the two transports.
    conn.off("data", onData);
    conn.pause();
    started = true;
    clearTimeout(timer);
    start(buf.subarray(0, nl).toString("utf8"), buf.subarray(nl + 1));
  };

  conn.on("data", onData);
  conn.on("error", (err) => {
    console.error(`[remote-mcp] ${deps.env.id}: connection error — ${err.message}`);
    // Before the preamble there is no server to release; after it, `release` is also bound to
    // "error" and destroys the socket. Destroying here covers the pre-preamble half.
    if (!started) conn.destroy();
  });
}

export interface RemoteMcpListener {
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * Bind one environment's listener. The socket is unlinked first: a unix socket file outlives the
 * process that made it, so a corral that was killed rather than shut down leaves one behind and the
 * next bind would fail with EADDRINUSE.
 */
export async function startEnvListener(deps: PinnedDeps, baseUrl: string): Promise<RemoteMcpListener> {
  mkdirSync(MCP_SOCKET_DIR, { recursive: true, mode: 0o700 });
  // Explicit, because mkdir's mode goes through the process umask and cannot be relied on.
  chmodSync(MCP_SOCKET_DIR, 0o700);
  const socketPath = localSocketPath(deps.env.id);
  rmSync(socketPath, { force: true });

  const server = net.createServer({ allowHalfOpen: false });
  server.maxConnections = MAX_CONNECTIONS;
  server.on("connection", (conn) => { serveConnection(conn, deps, baseUrl); });
  server.on("error", (err) => {
    console.error(`[remote-mcp] ${deps.env.id}: listener error — ${err.message}`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);

  return {
    socketPath,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}
