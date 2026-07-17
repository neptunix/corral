import type { SessionLink } from "@shared/board-schema.ts";

// A non-empty (present) stable-UUID guard — mirrors the read-side resolver's `!== null && !== ""`.
function hasId(s: string | null): boolean {
  return s !== null && s !== "";
}

// Is the incoming live session already bound by one of `links`? This is the EXACT per-link complement
// of buildUnassigned (server/api.ts:65-72), expressed as two INDEPENDENT disjuncts — NOT a
// `liveSessionId ? … : …` ternary (that shape reintroduces the /new-window bug):
//   - a link WITHOUT a sessionId claims its pane   (env:paneId), and
//   - a link WITH a sessionId claims its session   (env:sessionId, only when the live row has a UUID).
// A stale non-null pane-mate therefore never binds a restarted session, and a live row whose UUID is
// briefly null mid-`/new` binds nothing (it is genuinely unassigned).
export function isSessionBound(
  links: readonly SessionLink[],
  incoming: { readonly env: string; readonly paneId: string; readonly liveSessionId: string | null },
): boolean {
  const { env, paneId, liveSessionId } = incoming;
  return links.some((l) =>
    (!hasId(l.sessionId) && l.env === env && l.paneId === paneId) ||
    (hasId(liveSessionId) && l.env === env && l.sessionId === liveSessionId),
  );
}

// Which stored link does a per-card action (detach/close/resume) target? Returns the index into
// `links`, or -1.
//   - An explicit sessionId is AUTHORITATIVE: match it exactly, or -1. It NEVER falls through to paneId
//     — with two same-pane links a stale-frame sid that matches nothing must not resolve to the wrong
//     sibling (close would kill the live one's tab; resume would respawn it). detach treats -1 as a
//     safe no-op (idempotent); close/resume 404.
//   - No sessionId (legacy caller / a link whose id isn't backfilled yet): resolve by paneId, else
//     churn-heal by the live row's sessionId (a herdr restart relocated the pane).
export function resolveLinkIndex(
  links: readonly SessionLink[],
  target: {
    readonly env: string; readonly paneId: string;
    readonly sessionId: string | null; readonly liveSessionId: string | null;
  },
): number {
  const { env, paneId, sessionId, liveSessionId } = target;
  if (hasId(sessionId)) {
    return links.findIndex((l) => l.env === env && l.sessionId === sessionId);
  }
  const byPane = links.findIndex((l) => l.env === env && l.paneId === paneId);
  if (byPane !== -1) return byPane;
  if (hasId(liveSessionId)) {
    return links.findIndex((l) => l.env === env && l.sessionId === liveSessionId);
  }
  return -1;
}
