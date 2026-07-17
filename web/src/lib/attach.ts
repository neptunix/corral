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
