import { z } from "zod";

// Minimal structural shapes so the bridge is unit-testable with plain mocks — a real `node-pty`
// IPty and a real `ws` WebSocket are each structurally assignable to these.
export interface PtyLike {
  onData(cb: (data: string | Buffer) => void): void;
  onExit(cb: () => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface WsLike {
  // Real `ws` calls message listeners as (data, isBinary); the second arg is what lets us tell a text
  // control frame (isBinary===false) from binary keystrokes — text frames arrive as Buffers, not strings.
  on(event: string, cb: (...args: unknown[]) => void): void;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  terminate(): void;
  readonly bufferedAmount: number;
}

const ControlSchema = z.object({
  type: z.literal("resize"),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const DEFAULT_MAX_BUFFERED = 1_000_000;

/**
 * Bridge a PTY to a WebSocket, both directions. Returns a teardown fn (idempotent).
 * - pty → ws: binary frames, dropped past `maxBuffered` of `ws.bufferedAmount` (backpressure: a
 *   flooding agent must not OOM the dashboard — dropping bytes is the spec'd tradeoff over unbounded buffering).
 * - ws → pty: BINARY frames are raw keystrokes (`pty.write`); TEXT frames are JSON control (`{type:"resize"}`).
 *   Text vs binary is decided by the JS string check (mocks) OR real-`ws`'s `isBinary===false` — never by
 *   sniffing bytes, so a keystroke that happens to be valid JSON is still typed, not interpreted.
 * - reaping (SEC-3): ws close/error → SIGHUP then SIGKILL after `graceMs`; pty exit → ws close; the
 *   ping/pong heartbeat reaps half-open links (laptop sleep, killed tab): TCP alone surfaces those only
 *   after a multi-minute timeout, so a peer that leaves a ping unanswered for a full interval is
 *   terminate()d — a dead browser must not hold the herdr --takeover input lock or a limiter slot.
 * All inbound handling is hardened against untrusted input: JSON.parse is guarded, the control frame is
 * Zod-validated, and kill()/write()/resize() are wrapped (calls on an already-exited pty can throw).
 */
export function bridgePtyToWs(
  pty: PtyLike,
  ws: WsLike,
  opts: { graceMs: number; heartbeatMs: number; maxBuffered?: number },
): () => void {
  const maxBuffered = opts.maxBuffered ?? DEFAULT_MAX_BUFFERED;
  let closed = false;

  function safeKill(signal: string): void {
    try {
      pty.kill(signal);
    } catch {
      /* pty already gone — killing an exited process can throw ESRCH/EPERM; ignore */
    }
  }

  // write/resize can throw on a pty that exited a moment ago, while `closed` is still false (the
  // exit event races the inbound frame) — same hazard class as safeKill, same treatment.
  function safeWrite(data: string): void {
    try {
      pty.write(data);
    } catch {
      /* pty just exited — onExit will close the ws */
    }
  }

  function safeResize(cols: number, rows: number): void {
    try {
      pty.resize(cols, rows);
    } catch {
      /* pty just exited — onExit will close the ws */
    }
  }

  function handleControl(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return; // non-JSON text frame — ignore, never throw on untrusted input
    }
    const parsed = ControlSchema.safeParse(json);
    if (parsed.success) safeResize(parsed.data.cols, parsed.data.rows);
  }

  pty.onData((data) => {
    if (closed || ws.bufferedAmount > maxBuffered) return; // backpressure: drop rather than OOM
    ws.send(typeof data === "string" ? Buffer.from(data) : data);
  });
  pty.onExit(() => {
    if (!closed) ws.close(1000, "pty exited");
  });

  ws.on("message", (raw, isBinary) => {
    if (closed) return;
    if (typeof raw === "string") {
      handleControl(raw);
      return;
    }
    if (isBinary === false && Buffer.isBuffer(raw)) {
      handleControl(raw.toString("utf8")); // real-ws text control frame
      return;
    }
    if (Buffer.isBuffer(raw)) safeWrite(raw.toString("utf8")); // binary = raw keystrokes
  });

  // Standard `ws` isAlive liveness: each tick first checks the previous ping was answered. A peer
  // that missed a whole heartbeat interval is half-open — terminate() destroys the TCP socket
  // (which also fires 'close' on a real ws); teardown() runs first so mocks without event plumbing
  // still reap, and it is idempotent for the real double path.
  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (closed) return;
    if (!alive) {
      teardown();
      try {
        ws.terminate();
      } catch {
        /* socket already destroyed */
      }
      return;
    }
    alive = false;
    ws.ping();
  }, opts.heartbeatMs);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  function teardown(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    safeKill("SIGHUP");
    const t = setTimeout(() => { safeKill("SIGKILL"); }, opts.graceMs);
    if (typeof t.unref === "function") t.unref();
  }
  ws.on("close", teardown);
  ws.on("error", teardown);

  return teardown;
}
