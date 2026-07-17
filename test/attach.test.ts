import { describe, expect, it } from "vitest";

import { shouldRetryAttach, ATTACH_RETRY_WINDOW_MS } from "../web/src/lib/attach.ts";

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
