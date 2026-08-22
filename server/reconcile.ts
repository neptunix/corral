import type { SessionLink } from "@shared/board-schema";

import { displacingName } from "./link-name.ts";
import { buildLiveIndex, resolveLiveRow, type LiveIndex } from "./live-resolve.ts";
import type { Poller } from "./poller.ts";
import type { Storage } from "./storage.ts";

// Two writes onto stored SessionLinks, sharing one transaction per board: the sessionId BACKFILL, and
// the name MIRROR that keeps link.name following the live Claude session's name.
//
// Backfill the stable Claude sessionId onto stored SessionLinks once it becomes available. A link is
// created (especially at spawn) before Claude registers on the pane, so its sessionId starts null; the
// live row gains the id a poll or two later. On each poller snapshot we copy that id onto the link —
// strictly null → value, never overwriting an existing id.
//
// Write discipline: `storage.withBoard` does NOT diff — any non-null board it returns is rewritten to
// disk (and dirties the git-backed store). The poller emits a snapshot every ~30 s per env, so a naive
// writer would rewrite every board on every poll. We therefore pre-scan in memory and call withBoard
// ONLY for boards with at least one real null → value backfill; a steady state (every link already has
// its id) does zero writes. An in-flight guard keeps rapid back-to-back snapshots from stacking
// concurrent writes on the same board, and the backfill is recomputed inside the mutex against the
// freshly-read board so a concurrent edit can't be clobbered.
//
// Identity caveat (accepted): a null-sessionId link is identifiable ONLY by its paneId — that is the
// whole reason we're backfilling — so we must key the backfill on paneId. If that paneId were reused by
// a DIFFERENT agent before we backfill, we'd persist the wrong id. The window is tiny: the dominant
// source of null links is a fresh spawn, which the poller backfills within one interval (~30 s), so
// poisoning needs a herdr restart that reassigns the pane inside that window. Once a link has an id,
// buildBoardState resolves by sessionId (not paneId), so the durable read path stays id-safe.

// The name a stored link SHOULD carry, or null to leave it alone. Called from both the pre-scan and
// the write callback rather than writing the condition twice, so the two cannot drift apart — and the
// pre-scan must be exactly as strict as the write, because opening a board is ALWAYS a write
// (server/storage.ts has no no-op return path), so a looser gate rewrites the file every 3 s.
//
// Resolution is by sessionId, never by the pane: a link poisoned onto the wrong id would otherwise be
// renamed to a stranger's name on every snapshot, durably. `!== ""` as well as `!== null` because an
// unset id is either in this codebase — "" passes a non-null test, and resolveLiveRow would then fall
// back to plain paneId resolution, which is the hazard this keys on sessionId to avoid.
//
// One escalation worth knowing: pickLatest breaks an exact `updatedAt` tie by keeping the first
// record read (server/session-registry.ts), so a stale dead-PID file tying with the live one is
// resolved by directory order. That used to flicker a label; here it would rewrite the board and
// commit it. Narrow — a live record's updatedAt moves — but the failure changed in kind.
//
// Normalize BEFORE both tests. Comparing the raw name and storing the normalized one never converges;
// testing the raw name for non-emptiness lets a whitespace-only name normalize to "", the one value
// server/api.ts says must never be stored.
function mirrorNameFor(link: SessionLink, index: LiveIndex): string | null {
  if (link.sessionId === null || link.sessionId === "") return null;
  const row = resolveLiveRow(link, index);
  const next = row === undefined ? "" : displacingName(row);
  return next === "" || next === link.name ? null : next;
}

export function startReconciler(opts: { poller: Poller; storage: Storage }): () => void {
  const { poller, storage } = opts;
  const inFlight = new Set<string>();

  function onSnapshot(): void {
    const snapshot = poller.getSnapshot();
    const idByPane = new Map<string, string>();
    for (const s of snapshot.sessions) {
      if (s.sessionId !== null && s.sessionId !== "") idByPane.set(`${s.env}:${s.paneId}`, s.sessionId);
    }
    // bySession is filled under the identical predicate, so the two indexes are empty together and
    // this early return cannot skip a mirror that would otherwise have run.
    if (idByPane.size === 0) return;
    const index = buildLiveIndex(snapshot.sessions);

    for (const board of storage.getAllBoards()) {
      if (inFlight.has(board.id)) continue;
      const needsBackfill = board.tasks.some((t) =>
        t.sessions.some((l) => (l.sessionId === null || l.sessionId === "") && idByPane.has(`${l.env}:${l.paneId}`)));
      const needsMirror = board.tasks.some((t) => t.sessions.some((l) => mirrorNameFor(l, index) !== null));
      if (!needsBackfill && !needsMirror) continue;

      inFlight.add(board.id);
      void storage.withBoard(board.id, (existing) => {
        if (existing === null) return { board: null, result: undefined };
        // Recompute the backfill against the freshly-read board (never overwrite a non-null id). The
        // pre-scan already established at least one link needs filling; in the rare race where a
        // concurrent write filled it first, the rebuilt board is byte-identical, so writeAtomic
        // produces no git diff — no commit churn.
        const tasks = existing.tasks.map((t) => ({
          ...t,
          sessions: t.sessions.map((l) => {
            // Backfill and mirror are exclusive per link, and backfill wins: a link that gains its id
            // here is mirrored on the NEXT snapshot. Mirroring it in the same pass would inherit the
            // backfill's paneId-poisoning caveat — which is bounded for a one-shot null -> value write
            // but not for a name rewritten on every snapshot thereafter. The mirror is level-triggered,
            // so the wait costs one tick and never loses the rename.
            if (l.sessionId === null || l.sessionId === "") {
              const id = idByPane.get(`${l.env}:${l.paneId}`);
              return id === undefined ? l : { ...l, sessionId: id };
            }
            const next = mirrorNameFor(l, index);
            if (next === null) return l;
            console.warn(`[reconcile] name mirror: board ${existing.id} task ${t.id} session ${l.sessionId} "${l.name}" -> "${next}"`);
            return { ...l, name: next };
          }),
        }));
        return { board: { ...existing, tasks }, result: undefined };
      })
        .catch((err: unknown) => {
          const what = needsBackfill && needsMirror ? "backfill+name mirror" : needsBackfill ? "backfill" : "name mirror";
          console.warn(`[reconcile] ${what} failed for board ${board.id}: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => { inFlight.delete(board.id); });
    }
  }

  return poller.onSnapshot(onSnapshot);
}
