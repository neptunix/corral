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

// 0700: the local half of the per-user rule sshd enforces on the remote end of the forward.
export const MCP_SOCKET_DIR = path.join(CORRAL_HOME, "mcp");

export function localSocketPath(envId: string): string {
  return path.join(MCP_SOCKET_DIR, `${envId}.sock`);
}

const PREAMBLE_TIMEOUT_MS = 15_000;
// Far above honest load (one connection per session); it bounds fd use against a looping peer.
const MAX_CONNECTIONS = 64;

// One MCP server per connection, its environment fixed by which listener accepted it (ADR 0009).
function serveConnection(conn: net.Socket, deps: PinnedDeps, baseUrl: string): void {
  let buf = Buffer.alloc(0);
  let started = false;

  const fail = (reason: string): void => {
    console.error(`[remote-mcp] ${deps.env.id}: dropping connection — ${reason}`);
    conn.destroy();
  };

  let sawBytes = false;
  const timer = setTimeout(() => {
    if (started) return;
    // Silent when nothing was said at all: corral's own tunnel probe connects and hangs up each tick.
    if (sawBytes) fail("no preamble within the deadline");
    else conn.destroy();
  }, PREAMBLE_TIMEOUT_MS);
  timer.unref();

  const start = (line: string, rest: Buffer): void => {
    const parsed = parsePreamble(line);
    if (!parsed.ok) {
      fail(parsed.reason);
      return;
    }
    // Bytes sharing the preamble's chunk are pushed ahead of the pipe rather than lost.
    const through = new PassThrough();
    if (rest.length > 0) through.write(rest);
    conn.pipe(through);

    const client = createPinnedClient(baseUrl, deps);
    const identity = createIdentity(client, {
      paneId: parsed.preamble.paneId,
      cwd: parsed.preamble.cwd,
      socket: null,
    });
    // The one record that a remote session used these tools; ADR 0009 allows same-user impersonation.
    console.warn(`[remote-mcp] ${deps.env.id}: session opened for pane ${parsed.preamble.paneId}`);
    const server = new McpServer({ name: "corral", version: "0.1.0" }, { instructions: ORIENTATION });
    registerSelfTool(server, identity);
    registerTaskTools(server, { client, identity });
    registerSessionTools(server, { client, identity, envScope: deps.env.id });

    const transport = new StdioServerTransport(through, conn);
    // The SDK's transport never closes itself, so on a socket the peer's disconnect must release it.
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
    sawBytes = true;
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl === -1) {
      if (buf.length > PREAMBLE_MAX_BYTES) fail("preamble exceeded its size limit with no newline");
      return;
    }
    // Both synchronous and inside the handler, so no chunk is read twice or dropped in between.
    conn.off("data", onData);
    conn.pause();
    started = true;
    clearTimeout(timer);
    start(buf.subarray(0, nl).toString("utf8"), buf.subarray(nl + 1));
  };

  conn.on("data", onData);
  conn.on("error", (err) => {
    console.error(`[remote-mcp] ${deps.env.id}: connection error — ${err.message}`);
    // After the preamble `release` handles this; this covers the pre-preamble half.
    if (!started) conn.destroy();
  });
}

export interface RemoteMcpListener {
  readonly socketPath: string;
  close(): Promise<void>;
}

// Unlinks first: a corral that was killed leaves its socket file behind and the bind would EADDRINUSE.
export async function startEnvListener(deps: PinnedDeps, baseUrl: string): Promise<RemoteMcpListener> {
  mkdirSync(MCP_SOCKET_DIR, { recursive: true, mode: 0o700 });
  chmodSync(MCP_SOCKET_DIR, 0o700); // mkdir's mode goes through the umask

  const socketPath = localSocketPath(deps.env.id);
  rmSync(socketPath, { force: true });

  const server = net.createServer();
  server.maxConnections = MAX_CONNECTIONS;
  // close() only stops accepting; these connections are long-lived, so it would never settle.
  const live = new Set<net.Socket>();
  server.on("connection", (conn) => {
    live.add(conn);
    conn.on("close", () => live.delete(conn));
    serveConnection(conn, deps, baseUrl);
  });
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
    close: () => new Promise<void>((resolve) => {
      server.close(() => { resolve(); });
      for (const conn of live) conn.destroy();
      live.clear();
    }),
  };
}
