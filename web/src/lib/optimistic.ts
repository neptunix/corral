import type { EnrichedSessionLink, EnrichedTask } from "@shared/board-schema";

// Pending intent for a session row while a close/resume round-trip is in flight. Kept in a plain module
// so vitest can pin it (there is no React component runner) — mirrors web/src/lib/attach.ts.
export type OptimisticState = "closing" | "resuming";

// Synthetic `live.status` values the optimistic layer writes. Single-sourced so SessionRow can detect
// the transient (and suppress conflicting affordances) without re-hardcoding the string.
export const CLOSING_STATUS = "closing";
export const RESUMING_STATUS = "resuming";

// Key an optimistic override to a session's STABLE identity. Resume rebinds the link to a fresh paneId
// but KEEPS its sessionId, so id-first keying makes the override survive the rebind; a live session closed
// before the reconciler backfills its id has no sessionId yet, so we fall back to env:paneId — which a
// close never changes.
export function overrideKey(s: { readonly sessionId: string | null; readonly env: string; readonly paneId: string }): string {
  return s.sessionId !== null && s.sessionId !== "" ? s.sessionId : `${s.env}:${s.paneId}`;
}

function withOptimisticLive(s: EnrichedSessionLink, state: OptimisticState): EnrichedSessionLink {
  // recap/recapAt/statusline placeholders: the optimistic overlay doesn't touch them (task 7 wires
  // real values); required only because LiveSessionData's schema defaults make them non-optional.
  const live = state === "closing"
    ? { status: CLOSING_STATUS, model: null, ctxPct: null, detached: true, recap: null, recapAt: null, statusline: null }
    : { status: RESUMING_STATUS, model: null, ctxPct: null, detached: false, recap: null, recapAt: null, statusline: null };
  return { ...s, live };
}

// Overlay pending close/resume intent onto the board so a row flips state instantly — before the
// poller-backed GET /api/state re-fetch (stale up to one poll) and the next SSE frame reconcile it. Pure:
// unmatched tasks/sessions pass through by reference; inputs are never mutated. Callers clear the
// override map on each SSE frame, so the overlay lasts only until reconciliation.
export function applyOptimisticState(
  tasks: readonly EnrichedTask[],
  overrides: ReadonlyMap<string, OptimisticState>,
): EnrichedTask[] {
  if (overrides.size === 0) return [...tasks];
  return tasks.map((t) => {
    const sessions = t.sessions.map((s) => {
      const state = overrides.get(overrideKey(s));
      return state === undefined ? s : withOptimisticLive(s, state);
    });
    // Preserve identity for untouched tasks (each session is returned by reference when unmatched).
    const unchanged = sessions.every((s, i) => s === t.sessions[i]);
    return unchanged ? t : { ...t, sessions };
  });
}
