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

export interface SessionMembership {
  readonly boardId: string;
  readonly taskTitle: string;
}

/**
 * env:paneId → { owning board id, owning task title }. The SINGLE board→task→session walk shared by
 * every consumer below — no duplicated traversal. Mirrors the server `buildUnassigned` membership.
 */
export function buildMembershipIndex(boards: readonly Board[]): Map<string, SessionMembership> {
  const index = new Map<string, SessionMembership>();
  for (const board of boards) {
    for (const task of board.tasks) {
      for (const link of task.sessions) {
        index.set(sessionKey(link.env, link.paneId), { boardId: board.id, taskTitle: task.title });
      }
    }
  }
  return index;
}

/** Per-board attention count for the switcher badges. Records bound to no task are excluded. */
export function attentionCountsByBoard(attention: AttentionMap, boards: readonly Board[]): Map<string, number> {
  const index = buildMembershipIndex(boards);
  const counts = new Map<string, number>();
  for (const key of Object.keys(attention)) {
    const m = index.get(key);
    if (m === undefined) continue; // unassigned — surfaces via the Unassigned tab, not a board badge
    counts.set(m.boardId, (counts.get(m.boardId) ?? 0) + 1);
  }
  return counts;
}

export interface BoardAttentionEntry {
  readonly key: string;
  readonly record: AttentionRecord;
  readonly taskTitle: string;
}

/** The active board's attention entries, blocked-first then most-recent, each carrying its task title. */
export function boardAttention(
  attention: AttentionMap, boards: readonly Board[], boardId: string,
): BoardAttentionEntry[] {
  const index = buildMembershipIndex(boards);
  const entries: BoardAttentionEntry[] = [];
  for (const [key, record] of Object.entries(attention)) {
    const m = index.get(key);
    if (m?.boardId !== boardId) continue;
    entries.push({ key, record, taskTitle: m.taskTitle });
  }
  entries.sort((a, b) => {
    if (a.record.state !== b.record.state) return a.record.state === "blocked" ? -1 : 1;
    return b.record.since - a.record.since;
  });
  return entries;
}

/** Count of attention records whose session is bound to no task — the "Unassigned sessions" badge. */
export function unassignedAttentionCount(attention: AttentionMap, boards: readonly Board[]): number {
  const index = buildMembershipIndex(boards);
  let count = 0;
  for (const key of Object.keys(attention)) {
    if (!index.has(key)) count += 1;
  }
  return count;
}
