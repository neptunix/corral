// Client half of the post-spawn attach boot-race contract, kept in a plain module so vitest can pin
// it (there is no React component runner) — mirrors web/src/lib/protocol.ts. `agent attach` returns
// WS close 4001 until Claude registers as a herdr agent (a few seconds after `pane run`), so the
// auto-opened live terminal (awaitAgent) retries the attach until the connection stays live past the
// server probe grace (WS_PROBE_GRACE_MS = 2000), never showing the transient error blob.
export const ATTACH_RETRY_WINDOW_MS = 25_000;
export const ATTACH_RETRY_DELAY_MS = 1_200;
export const ATTACH_LIVE_AFTER_MS = 2_300; // must exceed the server probe grace (2 s): open longer ⇒ live

/**
 * True when a not-yet-live post-spawn attach closed with 4001 and should be retried (still in window).
 * Narrowly scoped to 4001 on purpose: a spawn-failure (4000), limit (1013), or normal exit (1000) must
 * NOT retry, and a manual (non-await) or already-live attach must NOT retry.
 */
export function shouldRetryAttach(e: {
  readonly code: number;
  readonly live: boolean;
  readonly awaitAgent: boolean;
  readonly elapsedMs: number;
}): boolean {
  return !e.live && e.code === 4001 && e.awaitAgent && e.elapsedMs < ATTACH_RETRY_WINDOW_MS;
}

// ── Reconnect after a drop ──
// A frozen tab (iOS suspends the whole browser process; Safari also force-closes sockets on bfcache
// entry) stops answering the server's ping, so pty-bridge.ts reaps the attach and the terminal is
// left dead with no way back but closing the modal. Everything below is the client half of the
// recovery. Design: docs/specs/2026-08-17-terminal-reconnect-on-resume-design.md.

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 30_000;
/**
 * How long to wait out a 1013 before re-attaching. MIRRORS the server: it must outlast both the
 * heartbeat reap that frees a stranded slot (`2 × WS_HEARTBEAT_MS + WS_KILL_GRACE_MS`) and the
 * limiter's rate window (`WS_RATE_WINDOW_MS`) — whichever is longer.
 *
 * A literal rather than an import because `config.ts` is server code and its `intFromEnv` reads
 * `process.env`, which cannot come along into the web bundle (same reason protocol.ts mirrors the
 * close codes). `test/attach.test.ts` runs in node, imports both sides and asserts the derivation,
 * so raising WS_HEARTBEAT_MS fails a test instead of silently making the retry land too early.
 */
export const RECONNECT_LIMIT_DELAY_MS = 62_000;
/**
 * Attempts allowed to a socket that has NEVER completed a handshake. A rejected upgrade — bad
 * origin, unknown env, malformed pane (`server/ws-attach.ts` rejectUpgrade) — never becomes a
 * WebSocket at all, so the browser reports 1006, exactly like a dead TCP connection. Retrying that
 * forever would hide a permanent misconfiguration behind a spinner; a socket that HAS opened once
 * is a corral restart or a suspended phone and retries without limit.
 */
export const RECONNECT_COLD_ATTEMPTS = 6;
/** How long to let a poked socket reveal that it is actually dead (see `resumeAction`). */
export const RESUME_PROBE_MS = 1_500;

/**
 * True for close codes that mean the transport died and re-attaching is worth it.
 *
 * An allowlist, deliberately: 1000 is the server saying the pty exited (the session ENDED), 1009 is
 * an over-size paste that a retry would repeat verbatim, and 4000/4001 are the attach itself
 * failing — none of them get better by trying again. 1013 does: the limiter clears itself as
 * stranded attaches are reaped, and a refused `tryReserve` returns before incrementing either
 * counter (`server/ws-attach-guard.ts`), so waiting it out cannot deepen it.
 *
 * Disjoint from `shouldRetryAttach` by construction — 4001 belongs to the boot race alone.
 */
export function shouldReconnectAfterClose(code: number): boolean {
  return code === 1006 || code === 1005 || code === 1001 || code === 1013;
}

export type ResumeTrigger = "visible" | "pageshow";
export type ResumeDecision = "reconnect" | "probe" | "none";

/**
 * What to do when the tab comes back. `readyState` is the raw WebSocket constant.
 *
 * `closeCode` is the verdict of the close that already happened, or null while the socket lives. It
 * gates everything: the terminal effect does not re-run on a close, so after a 4001 or a 1009 these
 * listeners are still registered against a dead socket, and without the gate a return to the tab
 * would resurrect a session §3.2 just said must stay dead.
 *
 * CONNECTING is NOT treated as dead. A handshake is already in flight and its own `onclose` covers
 * failure; tearing it down would discard an in-flight attempt on exactly the slow connection this
 * feature exists for.
 */
export function resumeAction(e: {
  readonly trigger: ResumeTrigger;
  readonly persisted: boolean;
  readonly readyState: number;
  readonly closeCode: number | null;
}): ResumeDecision {
  if (e.closeCode !== null && !shouldReconnectAfterClose(e.closeCode)) return "none";
  // A bfcache restore is ground truth: Safari force-closes the socket on entry, so there is nothing
  // to probe. A non-persisted pageshow is an ordinary page load, not a resume.
  if (e.trigger === "pageshow") return e.persisted ? "reconnect" : "none";
  if (e.readyState === WebSocket.CLOSED || e.readyState === WebSocket.CLOSING) return "reconnect";
  if (e.readyState === WebSocket.CONNECTING) return "none";
  // OPEN, and that claim is what is under suspicion — WebKit has shipped sockets that never noticed
  // their own death. The caller pokes it and re-checks after RESUME_PROBE_MS.
  return "probe";
}

/** Deterministic backoff. Split from `jitter` so the series stays monotonic and pinnable. */
export function reconnectNominalMs(failures: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** failures, RECONNECT_MAX_MS);
}

/**
 * Spread a delay over 50–100 % of nominal so several open terminals do not retry in lockstep.
 * `rand` is injected rather than read from `Math.random` inside, so the bounds can be asserted.
 */
export function jitter(ms: number, rand: number): number {
  return ms * (0.5 + rand / 2);
}
