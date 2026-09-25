import type { BoardFrame } from "@shared/board-schema";
import type { AttentionMap, AttentionRecord, AttentionState } from "@shared/schema";

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
export function buildMembershipIndex(boards: readonly BoardFrame[]): Map<string, SessionMembership> {
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

export interface AttentionCounts { readonly blocked: number; readonly finished: number }
export const ZERO_COUNTS: AttentionCounts = { blocked: 0, finished: 0 };

function add(c: AttentionCounts, state: AttentionState): AttentionCounts {
  return state === "blocked" ? { ...c, blocked: c.blocked + 1 } : { ...c, finished: c.finished + 1 };
}

/** Tallies a set of records by state — the shared reducer behind every badge/title in the UI. */
export function countStates(records: readonly AttentionRecord[]): AttentionCounts {
  return records.reduce((c, r) => add(c, r.state), ZERO_COUNTS);
}

/** Keys of every session finished but not yet viewed — drives the per-row ✓ mark. */
export function finishedKeys(attention: AttentionMap): ReadonlySet<string> {
  return new Set(Object.entries(attention).filter(([, r]) => r.state === "finished").map(([k]) => k));
}

/** "(N) corral" when N blocked sessions need the operator, else the plain app name. */
export function documentTitle(blocked: number): string {
  return blocked > 0 ? `(${String(blocked)}) corral` : "corral";
}

/** Per-board attention counts, split by state, for the switcher badges. Unbound records are excluded. */
export function attentionCountsByBoard(attention: AttentionMap, boards: readonly BoardFrame[]): Map<string, AttentionCounts> {
  const index = buildMembershipIndex(boards);
  const counts = new Map<string, AttentionCounts>();
  for (const [key, record] of Object.entries(attention)) {
    const m = index.get(key);
    if (m === undefined) continue; // unassigned — surfaces via the Unassigned tab, not a board badge
    counts.set(m.boardId, add(counts.get(m.boardId) ?? ZERO_COUNTS, record.state));
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
  attention: AttentionMap, boards: readonly BoardFrame[], boardId: string,
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

/** Attention counts, split by state, for sessions bound to no task — the "Unassigned sessions" badge. */
export function unassignedAttentionCount(attention: AttentionMap, boards: readonly BoardFrame[]): AttentionCounts {
  const index = buildMembershipIndex(boards);
  let counts = ZERO_COUNTS;
  for (const [key, record] of Object.entries(attention)) {
    if (!index.has(key)) counts = add(counts, record.state);
  }
  return counts;
}
