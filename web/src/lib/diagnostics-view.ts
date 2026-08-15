import type { Check, DiagnosticsSnapshot } from "@shared/diagnostics-schema";

/**
 * The newest timestamp among SERVER-BACKED checks, or null when none carries one.
 *
 * Synthetic client checks (see `syntheticChecks`) deliberately carry `checkedAt: null` so they can
 * never freshen this number: the header prints it as "last checked", and a dead backend reading
 * "checked just now" over rows that are minutes stale is the exact lie this feature removes.
 */
export function maxCheckedAt(checks: readonly Check[]): number | null {
  let best: number | null = null;
  for (const c of checks) {
    if (c.checkedAt === null) continue;
    if (best === null || c.checkedAt > best) best = c.checkedAt;
  }
  return best;
}

/**
 * Which snapshot the rail renders. ONE slot, fed by both the SSE frame and the Recheck response, so
 * the badge digit and the rows it summarizes are the same value by construction.
 *
 * `incoming === null` means THE CARRIER IS ABSENT — no frame and no seed, which happens on every
 * board switch — and absence is not news. Anything non-null came from a live server and is compared.
 * Keeping those two cases apart is what makes the rest of this function a plain "strictly newer wins":
 * collapsing them (rev 1 did) makes the board-switch hold impossible, because a cleared frame and a
 * server that has swept nothing become the same value and the blank one always wins.
 *
 * A tie keeps the incumbent, so a redelivered sweep does not churn the panel. An incoming snapshot
 * with no timestamps still wins: that is a restarted server publishing `checks: []` until its first
 * sweep lands, and pinning pre-restart rows with nothing marking them stale is the worse failure.
 */
export function pickSnapshot(
  held: DiagnosticsSnapshot,
  incoming: DiagnosticsSnapshot | null,
): DiagnosticsSnapshot {
  if (incoming === null) return held;
  const heldAt = maxCheckedAt(held.checks);
  const incomingAt = maxCheckedAt(incoming.checks);
  if (heldAt === null || incomingAt === null) return incoming;
  return incomingAt > heldAt ? incoming : held;
}

/** The view-only group synthetic rows are lifted into; `CheckScope` has no "client" kind to express it. */
const SYNTHETIC_GROUP_KEY = "client";
const SYNTHETIC_IDS = new Set(["backend-unreachable", "sweep-failed"]);

/**
 * Conditions the server's own rollup structurally cannot report: the panel cannot be a server check
 * about the server whose death it reports, and a sweep that throws cannot file a report about itself.
 * Both are minted as ordinary `Check` values so they flow through ONE code path into grouping, the
 * rollup, the badge digit and the auto-open trigger.
 *
 * `scope` and `class` are forced to existing enum members because the wire schema is frozen this
 * stage; the grouper lifts these two ids out by id, not by scope.
 */
export function syntheticChecks(snapshot: DiagnosticsSnapshot, streamDown: boolean): Check[] {
  const rows: Check[] = [];
  const base = {
    state: "problem", severity: "fatal", doc: null,
    scope: { kind: "global" }, class: "network",
    checkedAt: null, startupOkLine: false, haltsStartup: false,
  } as const;
  if (streamDown) {
    rows.push({
      ...base, id: "backend-unreachable", key: "backend-unreachable",
      title: "corral is not answering",
      detail: "The dashboard lost its connection to the corral server. Every row below predates the "
        + "disconnect. The page keeps retrying on its own.",
    });
  }
  if (snapshot.lastError !== null) {
    rows.push({
      ...base, id: "sweep-failed", key: "sweep-failed",
      title: "the diagnostics sweep is failing",
      detail: `The last sweep threw and the rows below are the previous run's: ${snapshot.lastError}`,
    });
  }
  return rows;
}

/** Server checks plus synthetics — the single list every derived value reads (badge, header, age). */
export function renderedChecks(snapshot: DiagnosticsSnapshot, streamDown: boolean): Check[] {
  return [...syntheticChecks(snapshot, streamDown), ...snapshot.checks];
}
