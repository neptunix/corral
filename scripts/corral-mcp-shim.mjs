#!/usr/bin/env node
// Pipes Claude's MCP stdio to a unix socket corral forwards here, after one preamble line. See README.

import net from "node:net";
import process from "node:process";

const SOCKET = process.env.CORRAL_MCP_SOCKET ?? "";
const PANE_ID = process.env.HERDR_PANE_ID ?? "";

function die(message) {
  // stderr only: a stray byte on stdout is an MCP protocol error.
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
  // ENOENT: never forwarded. ECONNREFUSED: a leftover file from a forward that is gone.
  const hint = code === "ENOENT" || code === "ECONNREFUSED"
    ? "corral is not connected to this host right now — no corral tools this session."
    : `unexpected socket error (${code}).`;
  die(`${hint} socket: ${SOCKET}`);
});

conn.on("connect", () => {
  conn.write(`${JSON.stringify({ v: 1, paneId: PANE_ID, cwd: process.cwd() })}\n`);
  process.stdin.pipe(conn);
  conn.pipe(process.stdout);
});

// Exiting is how a re-established tunnel is picked up: Claude starts a fresh shim on reconnect.
conn.on("close", () => { process.exit(0); });
process.stdin.on("end", () => { conn.end(); });
