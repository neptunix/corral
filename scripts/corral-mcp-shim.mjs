#!/usr/bin/env node
// Pipes Claude's MCP stdio to a unix socket corral forwards here, after one preamble line. See README.

import net from "node:net";
import process from "node:process";

const SOCKET = process.env.CORRAL_MCP_SOCKET ?? "";
const PANE_ID = process.env.HERDR_PANE_ID ?? "";
const RETRY_MS = Number(process.env.CORRAL_MCP_SHIM_RETRY_MS ?? "2000");
const DOWN_MESSAGE = "corral is not connected to this host right now (restarting?) — retry shortly.";

function log(message) {
  // stderr only: a stray byte on stdout is an MCP protocol error.
  process.stderr.write(`[corral-mcp-shim] ${message}\n`);
}

function die(message) {
  log(message);
  process.exit(1);
}

if (SOCKET === "") {
  die("CORRAL_MCP_SOCKET is not set — it must name the socket corral forwards onto this host (see the corral README).");
}
if (PANE_ID === "") {
  die("HERDR_PANE_ID is not set — this session is not running in a herdr pane, so it has no corral identity.");
}

// "connecting" queues Claude's lines, "up" forwards them, "down" answers requests with an error.
let state = "connecting";
let conn = null;
let everUp = false;
let stdinEnded = false;
let initLine = null;
let initializedLine = null;
let replayId = null;
let replays = 0;
const queued = [];
const inFlight = new Map();

function parse(line) {
  try {
    const msg = JSON.parse(line);
    return typeof msg === "object" && msg !== null ? msg : null;
  } catch {
    return null;
  }
}

const isRequest = (msg) => msg !== null && "id" in msg && typeof msg.method === "string";

function reply(id, error) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error })}\n`);
}

function forward(line, msg) {
  if (isRequest(msg)) inFlight.set(JSON.stringify(msg.id), msg.id);
  conn.write(`${line}\n`);
}

function fromClaude(line) {
  const msg = parse(line);
  if (msg?.method === "initialize") initLine = line;
  if (msg?.method === "notifications/initialized") initializedLine = line;
  if (state === "up") forward(line, msg);
  else if (state === "connecting") queued.push(line);
  else if (isRequest(msg)) reply(msg.id, { code: -32000, message: DOWN_MESSAGE });
}

function goUp() {
  state = "up";
  for (const line of queued.splice(0)) forward(line, parse(line));
}

function fromCorral(line) {
  const msg = parse(line);
  if (replayId !== null && msg !== null && msg.id === replayId) {
    replayId = null;
    if ("error" in msg) {
      log(`corral refused the replayed handshake (${JSON.stringify(msg.error)}) — retrying.`);
      conn.destroy();
      return;
    }
    if (initializedLine !== null) conn.write(`${initializedLine}\n`);
    // Corral may have been upgraded across the restart, so the tool list Claude holds can be stale.
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`);
    log("reconnected to corral.");
    goUp();
    return;
  }
  if (msg !== null && "id" in msg && !("method" in msg)) inFlight.delete(JSON.stringify(msg.id));
  process.stdout.write(`${line}\n`);
}

function lineReader(onLine) {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() !== "") onLine(line);
      nl = buf.indexOf("\n");
    }
  };
}

function connect() {
  const sock = net.createConnection(SOCKET);
  conn = sock;
  sock.on("connect", () => {
    sock.write(`${JSON.stringify({ v: 1, paneId: PANE_ID, cwd: process.cwd() })}\n`);
    if (everUp && initLine !== null) {
      state = "connecting";
      replayId = `corral-shim-replay-${String(++replays)}`;
      sock.write(`${JSON.stringify({ ...parse(initLine), id: replayId })}\n`);
    } else {
      goUp();
    }
    everUp = true;
  });
  sock.on("data", lineReader(fromCorral));
  sock.on("error", (err) => {
    const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
    if (everUp) return;
    // ENOENT: never forwarded. ECONNREFUSED: a leftover file from a forward that is gone.
    const hint = code === "ENOENT" || code === "ECONNREFUSED"
      ? "corral is not connected to this host right now — no corral tools this session."
      : `unexpected socket error (${code}).`;
    die(`${hint} socket: ${SOCKET}`);
  });
  // Claude never restarts a stdio server that exits, so a dropped tunnel is waited out, not exited on.
  sock.on("close", () => {
    if (stdinEnded) process.exit(0);
    if (state !== "down") log("lost the connection to corral — reconnecting.");
    state = "down";
    replayId = null;
    for (const id of inFlight.values()) reply(id, { code: -32000, message: DOWN_MESSAGE });
    inFlight.clear();
    for (const msg of queued.splice(0).map(parse)) if (isRequest(msg)) reply(msg.id, { code: -32000, message: DOWN_MESSAGE });
    setTimeout(connect, RETRY_MS);
  });
}

process.stdin.on("data", lineReader(fromClaude));
process.stdin.on("end", () => {
  stdinEnded = true;
  if (state === "up") conn.end();
  else process.exit(0);
});

connect();
