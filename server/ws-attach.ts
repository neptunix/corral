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

  // First-attach probe: a healthy attach to a live agent streams and stays alive. If the pty exits
  // within the probe grace, the attach is unavailable (herdr error / pane gone) — surface a distinct
  // close reason. Registered BEFORE the bridge so this reason wins the ws.close race over the bridge's
  // generic "pty exited". Task 0 confirmed the 0.7.1 stream is raw, so this only fires on real failures.
  pty.onExit(() => {
    if (ctx.now() - spawnedAt < WS_PROBE_GRACE_MS) {
      try {
        ctx.ws.close(4001, "attach unavailable");
      } catch {
        /* already closing */
      }
    }
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
