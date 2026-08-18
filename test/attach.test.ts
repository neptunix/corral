import { describe, expect, it } from "vitest";

import { WS_HEARTBEAT_MS, WS_KILL_GRACE_MS, WS_RATE_WINDOW_MS } from "../config.ts";
import {
  ATTACH_RETRY_WINDOW_MS, jitter, RECONNECT_BASE_MS, RECONNECT_LIMIT_DELAY_MS, RECONNECT_MAX_MS,
  reconnectNominalMs, resumeAction, shouldReconnectAfterClose, shouldRetryAttach,
} from "../web/src/lib/attach.ts";

// Pins the post-spawn attach retry contract (SessionModal): only a not-yet-live 4001 within the window
// retries. Widening this (e.g. to `code >= 4000`) would make real spawn failures retry-loop for 25 s
// stuck on "starting…" — these cases fail loudly if that happens.
describe("shouldRetryAttach", () => {
  const base = { code: 4001, live: false, awaitAgent: true, elapsedMs: 0 };

  it("retries a not-yet-live 4001 within the window (the boot-race happy path)", () => {
    expect(shouldRetryAttach(base)).toBe(true);
  });

  it("stops once the retry window elapses", () => {
    expect(shouldRetryAttach({ ...base, elapsedMs: ATTACH_RETRY_WINDOW_MS })).toBe(false);
  });

  it("never retries a non-4001 close (spawn-fail 4000, limit 1013, normal exit 1000)", () => {
    for (const code of [4000, 1013, 1000]) {
      expect(shouldRetryAttach({ ...base, code }), `code ${String(code)}`).toBe(false);
    }
  });

  it("never retries a manual (non-await) attach", () => {
    expect(shouldRetryAttach({ ...base, awaitAgent: false })).toBe(false);
  });

  it("never retries once the connection went live", () => {
    expect(shouldRetryAttach({ ...base, live: true })).toBe(false);
  });
});

// ── Reconnect contract ──

describe("shouldReconnectAfterClose", () => {
  it("reconnects the codes that mean the transport died", () => {
    for (const code of [1006, 1005, 1001]) {
      expect(shouldReconnectAfterClose(code), `code ${String(code)}`).toBe(true);
    }
  });

  it("reconnects 1013 — the limiter clears itself, and a refused retry does not deepen it", () => {
    expect(shouldReconnectAfterClose(1013)).toBe(true);
  });

  it("never reconnects a deliberate end or a deterministic failure", () => {
    // 1000 the session ended; 1009 an over-size paste would repeat verbatim; 4000/4001 the attach failed.
    for (const code of [1000, 1009, 4000, 4001]) {
      expect(shouldReconnectAfterClose(code), `code ${String(code)}`).toBe(false);
    }
  });

  it("does not overlap the boot-race retry: 4001 belongs to shouldRetryAttach alone", () => {
    expect(shouldRetryAttach({ code: 4001, live: false, awaitAgent: true, elapsedMs: 0 })).toBe(true);
    expect(shouldReconnectAfterClose(4001)).toBe(false);
  });
});

// The client mirror of the server's reap window. `config.ts` is server code (intFromEnv reads
// process.env), so the web bundle cannot import it — this test runs in node and can, which makes it
// the tripwire: raising WS_HEARTBEAT_MS fails here instead of silently making the 1013 retry land
// before the attach it is waiting out has been reaped.
describe("RECONNECT_LIMIT_DELAY_MS mirrors the server's reap + rate windows", () => {
  it("outlasts both the heartbeat reap and the rate window", () => {
    expect(RECONNECT_LIMIT_DELAY_MS)
      .toBe(Math.max(2 * WS_HEARTBEAT_MS + WS_KILL_GRACE_MS, WS_RATE_WINDOW_MS));
  });
});

describe("resumeAction", () => {
  const visible = { trigger: "visible", persisted: false, closeCode: null } as const;

  it("a bfcache restore is ground truth — reconnect without probing", () => {
    expect(resumeAction({ trigger: "pageshow", persisted: true, readyState: 1, closeCode: null }))
      .toBe("reconnect");
  });

  it("a plain pageshow is an ordinary load, not a resume", () => {
    expect(resumeAction({ trigger: "pageshow", persisted: false, readyState: 1, closeCode: null }))
      .toBe("none");
  });

  it("a dead socket reconnects", () => {
    for (const readyState of [2, 3]) { // CLOSING, CLOSED
      expect(resumeAction({ ...visible, readyState }), `readyState ${String(readyState)}`)
        .toBe("reconnect");
    }
  });

  it("leaves an in-flight handshake alone — CONNECTING is not dead", () => {
    expect(resumeAction({ ...visible, readyState: 0 })).toBe("none");
  });

  it("probes a socket that claims to be open, because WebKit may not have noticed its death", () => {
    expect(resumeAction({ ...visible, readyState: 1 })).toBe("probe");
  });

  it("respects the close-code verdict: a non-retryable close is never resurrected on resume", () => {
    // The effect does not re-run on a close, so these listeners are still registered against a
    // socket that closed for a reason shouldReconnectAfterClose refused to retry.
    for (const closeCode of [1000, 4000, 4001, 1009]) {
      expect(resumeAction({ ...visible, readyState: 3, closeCode }), `code ${String(closeCode)}`)
        .toBe("none");
      expect(resumeAction({ trigger: "pageshow", persisted: true, readyState: 3, closeCode }))
        .toBe("none");
    }
  });

  it("still reconnects after a close that IS retryable", () => {
    expect(resumeAction({ ...visible, readyState: 3, closeCode: 1006 })).toBe("reconnect");
  });
});

describe("reconnectNominalMs", () => {
  it("starts at the base delay and doubles", () => {
    expect(reconnectNominalMs(0)).toBe(RECONNECT_BASE_MS);
    expect(reconnectNominalMs(1)).toBe(RECONNECT_BASE_MS * 2);
    expect(reconnectNominalMs(2)).toBe(RECONNECT_BASE_MS * 4);
  });

  it("is monotonic and never exceeds the cap, however long the outage runs", () => {
    let prev = 0;
    for (let n = 0; n < 40; n++) {
      const d = reconnectNominalMs(n);
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeLessThanOrEqual(RECONNECT_MAX_MS);
      prev = d;
    }
    expect(reconnectNominalMs(39)).toBe(RECONNECT_MAX_MS);
  });
});

// Split from reconnectNominalMs so the delay series stays deterministic and testable: a single
// jittered function is neither monotonic nor pinnable without stubbing a global.
describe("jitter", () => {
  it("spans 50-100% of the nominal delay — exact at both ends of the range", () => {
    expect(jitter(1000, 0)).toBe(500);
    // Math.random() never returns 1, so this end is a limit rather than a value the caller sees;
    // asserted exactly anyway, because a float-fuzzy boundary makes a flaky test.
    expect(jitter(1000, 1)).toBe(1000);
  });

  it("never returns more than the nominal, so the cap still holds", () => {
    for (const rand of [0, 0.1, 0.5, 0.75, 0.99]) {
      const d = jitter(RECONNECT_MAX_MS, rand);
      expect(d, `rand ${String(rand)}`).toBeGreaterThanOrEqual(RECONNECT_MAX_MS / 2);
      expect(d, `rand ${String(rand)}`).toBeLessThanOrEqual(RECONNECT_MAX_MS);
    }
  });
});
