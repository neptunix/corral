import type { Board } from "@shared/board-schema";
import type { AttentionMap, AttentionRecord } from "@shared/schema";

// Client-side per-board attention attribution. The client already holds every board's bindings
// (`api.boards.list()` → `board.tasks[].sessions[]`) and the full attention map on each SSE frame, so
// scoping the feed to a board and counting per board is pure client logic — no server/schema change.
// Kept in a plain module (mirrors lib/attach.ts) so vitest can pin it: there is no React test runner.

// Attention keys are `env:paneId` (server/attention-store.ts); build the same key from a session link.
function sessionKey(env: string, paneId: string): string {
  return `${env}:${paneId}`;
}

/** env:paneId → owning board id. Mirrors server `buildUnassigned`'s membership walk, keyed by board. */
export function buildBoardIndex(boards: readonly Board[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const board of boards) {
    for (const task of board.tasks) {
      for (const link of task.sessions) index.set(sessionKey(link.env, link.paneId), board.id);
    }
  }
  return index;
}

/** Per-board attention count for the switcher badges. Records bound to no task are excluded. */
export function attentionCountsByBoard(attention: AttentionMap, boards: readonly Board[]): Map<string, number> {
  const index = buildBoardIndex(boards);
  const counts = new Map<string, number>();
  for (const key of Object.keys(attention)) {
    const boardId = index.get(key);
    if (boardId === undefined) continue; // unassigned — surfaces via the Unassigned tab, not a board badge
    counts.set(boardId, (counts.get(boardId) ?? 0) + 1);
  }
  return counts;
}

/** The active board's attention records, blocked-first then most-recent (the sort AttentionFeed inlined). */
export function boardAttention(
  attention: AttentionMap, boards: readonly Board[], boardId: string,
): (readonly [string, AttentionRecord])[] {
  const index = buildBoardIndex(boards);
  const entries = Object.entries(attention).filter(([key]) => index.get(key) === boardId);
  entries.sort(([, a], [, b]) => {
    if (a.state !== b.state) return a.state === "blocked" ? -1 : 1; // blocked (needs a reply) above finished
    return b.since - a.since;
  });
  return entries;
}

/** Count of attention records whose session is bound to no task — the "Unassigned sessions" ⊙ badge. */
export function unassignedAttentionCount(attention: AttentionMap, boards: readonly Board[]): number {
  const index = buildBoardIndex(boards);
  let count = 0;
  for (const key of Object.keys(attention)) {
    if (!index.has(key)) count += 1;
  }
  return count;
}
