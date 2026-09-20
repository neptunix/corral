#!/usr/bin/env node
// corral MCP shim for a session on a REMOTE environment.
//
// Claude speaks MCP to this process over stdio. This process speaks nothing: it writes one preamble
// line naming the pane it is running in, then pipes both directions to a unix socket that corral
// reverse-forwards onto this host over its own ssh connection. Every tool, and the whole MCP
// protocol, lives on the corral host — so there is no corral checkout here and nothing to keep in
// step with the server's version. See docs/adr/0009-*.md.
//
// Dependency-free by requirement: a remote environment is expected to have Node and nothing else.
// Node 18+.
//
// Install (per Claude config dir, on the remote):
//   claude mcp add --scope user corral \
//     --env CORRAL_MCP_SOCKET=<the same path as this environment's "mcpSocket" in corral's config> \
//     -- node <path to this file>

import net from "node:net";
import process from "node:process";

const SOCKET = process.env.CORRAL_MCP_SOCKET ?? "";
const PANE_ID = process.env.HERDR_PANE_ID ?? "";

function die(message) {
  // stderr only: stdout is the MCP protocol channel and a stray byte there is a protocol error.
  process.stderr.write(`[corral-mcp-shim] ${message}\n`);
  process.exit(1);
}

if (SOCKET === "") {
  die("CORRAL_MCP_SOCKET is not set — it must name the socket corral forwards onto this host (see the corral README).");
}
if (PANE_ID === "") {
  die("HERDR_PANE_ID is not set — this session is not running in a herdr pane, so it has no corral identity.");
}

const conn = net.createConnection(SOCKET);

conn.on("error", (err) => {
  const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
  // ENOENT: corral has not forwarded the socket (or is not running). ECONNREFUSED: the file is a
  // leftover from a forward that is gone. Both mean the same thing to the operator, and neither is
  // worth a retry loop here — Claude restarts the server when the session reconnects.
  const hint = code === "ENOENT" || code === "ECONNREFUSED"
    ? "corral is not connected to this host right now — no corral tools this session."
    : `unexpected socket error (${code}).`;
  die(`${hint} socket: ${SOCKET}`);
});

conn.on("connect", () => {
  // No trailing state, no framing of our own: one JSON line, then raw bytes in both directions.
  conn.write(`${JSON.stringify({ v: 1, paneId: PANE_ID, cwd: process.cwd() })}\n`);
  process.stdin.pipe(conn);
  conn.pipe(process.stdout);
});

// Either end closing ends the session. Claude treats the exit as the server going away and will
// start a fresh shim on the next connect, which is also how a re-established tunnel is picked up.
conn.on("close", () => { process.exit(0); });
process.stdin.on("end", () => { conn.end(); });
