import type { Poller } from "./poller.ts";
import type { Storage } from "./storage.ts";

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
export function startReconciler(opts: { poller: Poller; storage: Storage }): () => void {
  const { poller, storage } = opts;
  const inFlight = new Set<string>();

  function onSnapshot(): void {
    const snapshot = poller.getSnapshot();
    const idByPane = new Map<string, string>();
    for (const s of snapshot.sessions) {
      if (s.sessionId !== null && s.sessionId !== "") idByPane.set(`${s.env}:${s.paneId}`, s.sessionId);
    }
    if (idByPane.size === 0) return;

    for (const board of storage.getAllBoards()) {
      if (inFlight.has(board.id)) continue;
      const needs = board.tasks.some((t) =>
        t.sessions.some((l) => (l.sessionId === null || l.sessionId === "") && idByPane.has(`${l.env}:${l.paneId}`)));
      if (!needs) continue;

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
            if (l.sessionId !== null && l.sessionId !== "") return l;
            const id = idByPane.get(`${l.env}:${l.paneId}`);
            return id === undefined ? l : { ...l, sessionId: id };
          }),
        }));
        return { board: { ...existing, tasks }, result: undefined };
      })
        .catch((err: unknown) => {
          console.warn(`[reconcile] backfill failed for board ${board.id}: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => { inFlight.delete(board.id); });
    }
  }

  return poller.onSnapshot(onSnapshot);
}
