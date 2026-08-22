import type { Board, SessionLink, Task } from "@shared/board-schema.ts";
import type { SessionRow } from "@shared/schema";

// A non-empty (present) stable-UUID guard — mirrors the read-side resolver's `!== null && !== ""`.
function hasId(s: string | null): boolean {
  return s !== null && s !== "";
}

// Does this single stored link denote the given live session? This is the EXACT per-link complement
// of buildUnassigned (server/api.ts:65-72), expressed as two INDEPENDENT disjuncts — NOT a
// `liveSessionId ? … : …` ternary (that shape reintroduces the /new-window bug):
//   - a link WITHOUT a sessionId claims its pane   (env:paneId), and
//   - a link WITH a sessionId claims its session   (env:sessionId, only when the live row has a UUID).
// A stale non-null pane-mate therefore never binds a restarted session, and a live row whose UUID is
// briefly null mid-`/new` binds nothing (it is genuinely unassigned). Shared by `isSessionBound` below
// and the whoami card builder (server/whoami.ts) — the write-side (bind/close/resume) and the
// whoami read-side must agree on exactly one encoding of this rule.
export function linkBindsSession(
  link: SessionLink,
  incoming: { readonly env: string; readonly paneId: string; readonly liveSessionId: string | null },
): boolean {
  const { env, paneId, liveSessionId } = incoming;
  return (
    (!hasId(link.sessionId) && link.env === env && link.paneId === paneId) ||
    (hasId(liveSessionId) && link.env === env && link.sessionId === liveSessionId)
  );
}

// Is the incoming live session already bound by one of `links`?
export function isSessionBound(
  links: readonly SessionLink[],
  incoming: { readonly env: string; readonly paneId: string; readonly liveSessionId: string | null },
): boolean {
  return links.some((l) => linkBindsSession(l, incoming));
}

// Which stored link does a per-card action (detach/close/resume) target? Returns the index into
// `links`, or -1.
//   - An explicit sessionId is AUTHORITATIVE: match it exactly, or -1. It NEVER falls through to paneId
//     — with two same-pane links a stale-frame sid that matches nothing must not resolve to the wrong
//     sibling (close would kill the live one's tab; resume would respawn it). detach treats -1 as a
//     safe no-op (idempotent); close/resume 404.
//   - No sessionId (legacy caller / a link whose id isn't backfilled yet): resolve by paneId, else
//     churn-heal by the live row's sessionId (a herdr restart relocated the pane).
// The one place that walks every board looking for a session's card — whoami's task block and the
// card-empty signal both need it, and both must see the same card for the same session.
export function findCard(
  boards: readonly Board[],
  row: SessionRow,
): { readonly board: Board; readonly task: Task } | undefined {
  const incoming = { env: row.env, paneId: row.paneId, liveSessionId: row.sessionId };
  for (const board of boards) {
    for (const task of board.tasks) {
      if (task.sessions.some((l) => linkBindsSession(l, incoming))) {
        return { board, task };
      }
    }
  }
  return undefined;
}

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
