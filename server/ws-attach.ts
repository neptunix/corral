import { spawn } from "node-pty";
import { appendFile } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

import {
  ATTACH_AUDIT_LOG,
  WS_HEARTBEAT_MS,
  WS_KILL_GRACE_MS,
  WS_MAX_CONCURRENT,
  WS_MAX_PAYLOAD,
  WS_PROBE_GRACE_MS,
  WS_RATE_PER_WINDOW,
  WS_RATE_WINDOW_MS,
} from "../config.ts";
import type { HerdrEnv } from "../environments.ts";
import { buildAttachSpec } from "./herdr.ts";
import { bridgePtyToWs, type PtyLike, type WsLike } from "./pty-bridge.ts";
import { createSpawnLimiter, validateUpgrade } from "./ws-attach-guard.ts";

// node-pty is injectable so the assembly is testable without a real terminal (the manual smoke test,
// Task 10 §5, covers real node-pty + real herdr). A real IPty is structurally assignable to PtyLike.
export type PtySpawnFn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
) => PtyLike;

const defaultSpawn: PtySpawnFn = (file, args, options) => spawn(file, args, options);

interface AuditOpenEntry {
  readonly event: "open";
  readonly ts: string;
  readonly env: string;
  readonly paneId: string;
  readonly origin: string;
  readonly resolvedCommand: string;
}
interface AuditCloseEntry {
  readonly event: "close";
  readonly ts: string;
  readonly env: string;
  readonly paneId: string;
}
export type AuditEntry = AuditOpenEntry | AuditCloseEntry;

/**
 * SEC-6: the attach audit trail is open/close + source only. It deliberately carries NO keystroke
 * content (that would capture operator secrets, and is noise) — this pure serializer has no field for it.
 */
export function auditLine(entry: AuditEntry): string {
  return JSON.stringify(entry) + "\n";
}

// The WebSocket protocol caps a close reason at 123 BYTES and `ws` throws past it — a diagnostic that
// exceeded the cap would become a second, more opaque failure. The capture is bounded independently so
// a chatty child cannot grow the buffer without limit.
const CLOSE_REASON_MAX_BYTES = 123;
const PROBE_OUTPUT_MAX_CHARS = 512;

/**
 * Operator-facing close reason for an attach whose pty died inside the probe grace.
 *
 * Why the child's own output is the only source: node-pty forks SUCCESSFULLY even for a command that
 * does not exist — `execvp` fails in the child, so the parent's try/catch around the spawn never
 * fires, the attach is audited as a clean open with a fully-resolved-looking command, and the sole
 * evidence is what the child printed before exiting (`execvp(3) failed.: No such file or directory`).
 * Reporting a fixed "attach unavailable" discarded that and left a symptom with no cause.
 *
 * Sanitised (escape sequences and control bytes dropped, runs of blanks collapsed) and truncated on a
 * CHARACTER boundary so multi-byte output cannot emit a malformed reason. Empty input keeps the
 * historical string, which is also `closeMessage`'s client-side fallback.
 *
 * Deliberately NOT added to the attach audit log: SEC-6 keeps session content out of that trail and
 * this text is session output. It goes only to the operator already attached to that pane, over their
 * own socket — not into a persisted record.
 */
export function attachFailureReason(earlyOutput: string): string {
  let plain = "";
  let i = 0;
  while (i < earlyOutput.length) {
    const code = earlyOutput.charCodeAt(i);
    if (code === 0x1b) { // ESC: drop the whole sequence — introducer, parameters and final byte
      i += 1;
      if (earlyOutput.charCodeAt(i) === 0x5b) i += 1; // '[' of a CSI sequence
      while (i < earlyOutput.length) {
        const c = earlyOutput.charCodeAt(i);
        i += 1;
        if (c >= 0x40 && c <= 0x7e) break; // final byte terminates the sequence
      }
      continue;
    }
    plain += code < 0x20 || code === 0x7f ? " " : earlyOutput.charAt(i);
    i += 1;
  }
  const cleaned = plain.split(" ").filter((s) => s !== "").join(" ");
  if (cleaned === "") return "attach unavailable";
  // Trim whole CODE POINTS, not UTF-16 units: slicing units could strip half a surrogate pair and
  // leave a lone surrogate, which encodes to a replacement character in the reason the operator reads.
  const chars = Array.from(`attach failed: ${cleaned}`);
  while (chars.length > 0 && Buffer.byteLength(chars.join(""), "utf8") > CLOSE_REASON_MAX_BYTES) chars.pop();
  return chars.join("");
}

function appendAudit(logPath: string, entry: AuditEntry): void {
  appendFile(logPath, auditLine(entry), () => {
    /* audit is best-effort — a disk error must never break a live attach */
  });
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
};

function rejectUpgrade(socket: Duplex, status: number): void {
  const text = STATUS_TEXT[status] ?? "Bad Request";
  socket.write(`HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

// The upgrade path only needs `.on('upgrade', …)`; typing it structurally keeps this module decoupled
// from @hono/node-server's ServerType union (http.Server | Http2Server | Http2SecureServer all satisfy it).
interface UpgradableServer {
  on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void;
}

// `spawn`, `limiter`, `auditLogPath`, and `now` are genuine test seams (fake pty, exhausted limiter,
// audit assertions, probe-grace timing). Everything else reads the config constants directly —
// per-call overrides for them were dead surface.
export interface AttachServerOptions {
  readonly envs: readonly HerdrEnv[];
  readonly allowedOrigins: readonly string[];
  readonly spawn?: PtySpawnFn;
  readonly limiter?: { tryReserve: () => boolean; release: () => void };
  readonly auditLogPath?: string;
  readonly now?: () => number;
}

interface ConnectionCtx {
  readonly ws: WsLike;
  readonly env: HerdrEnv;
  readonly paneId: string;
  readonly origin: string;
  readonly spawnPty: PtySpawnFn;
  readonly auditLogPath: string;
  readonly now: () => number;
}

function onConnection(ctx: ConnectionCtx): void {
  const spec = buildAttachSpec(ctx.env, ctx.paneId, true); // takeover always — herdr releases it on detach
  const resolvedCommand = `${spec.file} ${spec.args.join(" ")}`;

  let pty: PtyLike;
  try {
    pty = ctx.spawnPty(spec.file, spec.args, {
      name: "xterm-256color",
      cols: 80, // placeholder until the client's first resize control frame lands
      rows: 24,
      cwd: process.cwd(),
      env: { ...(spec.env ?? process.env), TERM: "xterm-256color" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendAudit(ctx.auditLogPath, {
      event: "open", ts: new Date().toISOString(), env: ctx.env.id, paneId: ctx.paneId,
      origin: ctx.origin, resolvedCommand: `${resolvedCommand} [spawn failed: ${msg}]`,
    });
    ctx.ws.close(4000, "attach failed"); // reason the modal renders instead of a blank terminal
    return;
  }

  appendAudit(ctx.auditLogPath, {
    event: "open", ts: new Date().toISOString(), env: ctx.env.id, paneId: ctx.paneId,
    origin: ctx.origin, resolvedCommand,
  });

  const spawnedAt = ctx.now();
  let closeAudited = false;
  const auditClose = (): void => {
    if (closeAudited) return;
    closeAudited = true;
    appendAudit(ctx.auditLogPath, { event: "close", ts: new Date().toISOString(), env: ctx.env.id, paneId: ctx.paneId });
  };

  // Hold the child's first output so an exit inside the probe grace can name the REAL cause rather
  // than a fixed string (see attachFailureReason). Bounded in size, and dropped the moment the grace
  // has passed — a healthy long-lived session accumulates nothing.
  let earlyOutput = "";
  let capturing = true;
  pty.onData((d) => {
    if (!capturing) return; // latched off after the grace so a busy terminal pays one boolean, not a clock read
    if (ctx.now() - spawnedAt >= WS_PROBE_GRACE_MS) { capturing = false; earlyOutput = ""; return; }
    if (earlyOutput.length >= PROBE_OUTPUT_MAX_CHARS) return;
    earlyOutput += typeof d === "string" ? d : d.toString("utf8");
  });

  // First-attach probe: a healthy attach to a live agent streams and stays alive. If the pty exits
  // within the probe grace, the attach is unavailable (herdr error / pane gone) — surface a distinct
  // close reason. Registered BEFORE the bridge so this reason wins the ws.close race over the bridge's
  // generic "pty exited". Task 0 confirmed the 0.7.1 stream is raw, so this only fires on real failures.
  pty.onExit(() => {
    if (ctx.now() - spawnedAt < WS_PROBE_GRACE_MS) {
      try {
        ctx.ws.close(4001, attachFailureReason(earlyOutput));
      } catch {
        /* already closing */
      }
    }
    earlyOutput = "";
    auditClose();
  });
  ctx.ws.on("close", auditClose);

  bridgePtyToWs(pty, ctx.ws, { graceMs: WS_KILL_GRACE_MS, heartbeatMs: WS_HEARTBEAT_MS });
}

/**
 * Wire the WS live-terminal attach onto an existing http server. All validation runs in the raw
 * `upgrade` handler (OUTSIDE Hono middleware); the spawn slot is reserved SYNCHRONOUSLY before any
 * pty fork (SEC-2) and released on every teardown path via the socket's own close/error. Full
 * bidirectional by default (`takeover`): herdr's native --takeover grabs input and releases on detach.
 */
export function attachWebSocketServer(server: UpgradableServer, opts: AttachServerOptions): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false });
  const spawnPty = opts.spawn ?? defaultSpawn;
  const now = opts.now ?? Date.now;
  const limiter = opts.limiter ?? createSpawnLimiter({
    maxConcurrent: WS_MAX_CONCURRENT, ratePerWindow: WS_RATE_PER_WINDOW, windowMs: WS_RATE_WINDOW_MS, now,
  });
  const auditLogPath = opts.auditLogPath ?? ATTACH_AUDIT_LOG;

  server.on("upgrade", (req, socket, head) => {
    const check = validateUpgrade(req.url ?? "", { origin: req.headers.origin }, opts.envs, opts.allowedOrigins);
    if (!check.ok) {
      rejectUpgrade(socket, check.status);
      return;
    }

    // SEC-2: reserve synchronously, in the same tick as the check, BEFORE any fork — no await between.
    if (!limiter.tryReserve()) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(1013, "attach limit reached");
      });
      return;
    }

    // Release on the socket's own lifecycle: this fires on a handshake abort (cb never runs) AND on a
    // normal ws close (same underlying socket) — so the reserved slot can never leak. Guarded to once.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      limiter.release();
    };
    socket.once("close", release);
    socket.once("error", release);

    const origin = req.headers.origin ?? "";
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection({ ws, env: check.env, paneId: check.paneId, origin, spawnPty, auditLogPath, now });
    });
  });
}
