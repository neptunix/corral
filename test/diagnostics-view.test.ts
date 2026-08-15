import type { Check, DiagnosticsSnapshot } from "@shared/diagnostics-schema";
import { emptyDiagnostics } from "@shared/diagnostics-schema";
import { describe, expect, it } from "vitest";

import { maxCheckedAt, pickSnapshot } from "../web/src/lib/diagnostics-view";

function check(over: Partial<Check> = {}): Check {
  return {
    id: "node-version", key: "node-version", title: "node 22 meets the floor",
    state: "ok", severity: "info", detail: "", doc: null,
    scope: { kind: "global" }, class: "cheap",
    checkedAt: 1_000, startupOkLine: true, haltsStartup: false,
    ...over,
  };
}

function snapshot(over: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return { ...emptyDiagnostics(), ...over };
}

describe("maxCheckedAt", () => {
  it("is null when nothing carries a timestamp", () => {
    expect(maxCheckedAt([])).toBe(null);
    expect(maxCheckedAt([check({ checkedAt: null })])).toBe(null);
  });

  it("ignores nulls and returns the newest", () => {
    expect(maxCheckedAt([check({ checkedAt: 5 }), check({ checkedAt: null }), check({ checkedAt: 9 })])).toBe(9);
  });
});

describe("pickSnapshot", () => {
  // THE BOARD SWITCH. useEventSource clears its frame on a url change and the seed effect clears the
  // seed, so App has nothing to hand over. That is not news from the server — hold what is on screen.
  it("holds the current rows when there is no carrier at all", () => {
    const held = snapshot({ checks: [check({ checkedAt: 100 })] });
    expect(pickSnapshot(held, null)).toBe(held);
  });

  it("takes the first real snapshot over the blank initial state", () => {
    const incoming = snapshot({ checks: [check()] });
    expect(pickSnapshot(emptyDiagnostics(), incoming)).toBe(incoming);
  });

  it("ignores a snapshot older than the one on screen", () => {
    const held = snapshot({ checks: [check({ checkedAt: 100 })] });
    const incoming = snapshot({ checks: [check({ checkedAt: 50 })] });
    expect(pickSnapshot(held, incoming)).toBe(held);
  });

  // A restarted corral publishes checks:[] until its first sweep completes — seconds, with remote
  // probes. Pinning pre-restart rows, red digit and all, with nothing marking them stale is worse
  // than briefly showing "waiting for the first sweep". A LIVE server saying nothing still wins.
  it("lets a live server's empty sweep replace stale rows after a restart", () => {
    const held = snapshot({ checks: [check({ checkedAt: 100 })] });
    const blank = emptyDiagnostics();
    expect(pickSnapshot(held, blank)).toBe(blank);
  });

  it("keeps the incumbent on a tie, so a redelivered sweep does not churn the panel", () => {
    const held = snapshot({ checks: [check({ checkedAt: 100 })] });
    const incoming = snapshot({ checks: [check({ checkedAt: 100 })] });
    expect(pickSnapshot(held, incoming)).toBe(held);
  });

  it("takes a strictly newer snapshot", () => {
    const held = snapshot({ checks: [check({ checkedAt: 100 })] });
    const incoming = snapshot({ checks: [check({ checkedAt: 101 })] });
    expect(pickSnapshot(held, incoming)).toBe(incoming);
  });

  // The Recheck response out-stamps the frame in flight behind it, so the fresh answer is not reverted.
  it("does not let a frame already in flight revert a newer recheck", () => {
    const rechecked = snapshot({ checks: [check({ checkedAt: 200 })] });
    const stale = snapshot({ checks: [check({ checkedAt: 150 })] });
    expect(pickSnapshot(rechecked, stale)).toBe(rechecked);
  });
});
