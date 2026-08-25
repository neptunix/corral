import { z } from "zod";

/**
 * Which log entries THIS browser has already displayed, per card. The server holds no "seen" notion
 * — the frame's `logCount`/`lastLogAtMs` express size, and unreadness is per viewer — so the badge's
 * "N new" is derived here by remembering what the Log tab last showed. Same untrusted-boundary rules
 * as terminal-prefs.ts: another tab or an older build can put anything under this key.
 */
const KEY = "corral.log.seen";
const MAX_CARDS = 500;

const SeenSchema = z.object({ count: z.number(), atMs: z.number() });
const StoreSchema = z.record(z.string(), SeenSchema);

export type LogSeen = z.infer<typeof SeenSchema>;
type Store = z.infer<typeof StoreSchema>;

export function seenKey(boardId: string, taskId: string): string {
  return `${boardId}/${taskId}`;
}

function readStore(): Store {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed = StoreSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function readLogSeen(key: string): LogSeen | undefined {
  return readStore()[key];
}

export function markLogSeen(key: string, seen: LogSeen): void {
  // Re-inserted last: insertion order is the recency the bound evicts by.
  const entries = Object.entries(readStore()).filter(([k]) => k !== key);
  entries.push([key, seen]);
  const next = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_CARDS)));
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota or denied storage — the badge over-reports "new", which is the safe direction.
  }
}

/**
 * How many entries the badge should call new. Exact while no eviction ran between the two looks
 * (the count difference); once the quota evicts, the count stops growing while `lastLogAtMs` still
 * moves, so a newer timestamp with no count growth reads as "at least one".
 */
export function newSince(task: { readonly logCount: number; readonly lastLogAtMs: number | null }, seen: LogSeen | undefined): number {
  if (task.lastLogAtMs === null || task.logCount === 0) return 0;
  if (seen === undefined) return task.logCount;
  if (task.lastLogAtMs <= seen.atMs) return 0;
  return Math.max(1, task.logCount - seen.count);
}
