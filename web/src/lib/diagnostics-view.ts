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
