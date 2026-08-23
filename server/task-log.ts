import type { LogEntry, LogKind } from "../shared/board-schema.ts";

/**
 * One entry's text ceiling, INCLUSIVE of the truncation marker — a stored entry is never longer than
 * this. A decision with its reasoning fits in 200–300.
 */
export const LOG_ENTRY_TEXT_MAX = 400;

/**
 * SEPARATE quotas, and that is the whole point rather than a detail.
 *
 * A single shared cap would be actively harmful: moving a card into a closing column offers to close
 * every live session on it in one operator action, so a card with fifteen sessions produces a burst
 * of `session_closed` lines — under one cap that burst would evict exactly the notes the log exists
 * for. The `kind` filter lets a reader ignore the noise; only separate quotas stop the noise from
 * DELETING the signal.
 */
export const LOG_NOTE_QUOTA = 60;
export const LOG_SYSTEM_QUOTA = 140;

function isNote(entry: LogEntry): boolean {
  return entry.kind === "note";
}

function quotaFor(kind: LogKind): number {
  return kind === "note" ? LOG_NOTE_QUOTA : LOG_SYSTEM_QUOTA;
}

function capText(text: string): string {
  return text.length <= LOG_ENTRY_TEXT_MAX ? text : `${text.slice(0, LOG_ENTRY_TEXT_MAX - 1)}…`;
}

/**
 * Append one entry, capping its text and evicting the oldest entries of ITS OWN family until that
 * family fits its quota. Append order across families is preserved — the log is read as one
 * chronological sequence and only the eviction is per-family.
 *
 * Eviction is a rewrite, which §4's append-only rule does not forbid: entries are never EDITED in
 * place, and two sessions appending concurrently still never destroy each other's text. The board
 * file is rewritten whole on every mutation regardless, so eviction costs nothing extra.
 */
export function appendLogEntry(log: readonly LogEntry[], entry: LogEntry): LogEntry[] {
  const next = [...log, { ...entry, text: capText(entry.text) }];
  const quota = quotaFor(entry.kind);
  const sameFamily = (e: LogEntry): boolean => isNote(e) === isNote(entry);
  let excess = next.filter(sameFamily).length - quota;
  if (excess <= 0) return next;
  // Drop from the front — oldest first — and only within the family that overflowed.
  return next.filter((e) => {
    if (excess > 0 && sameFamily(e)) {
      excess -= 1;
      return false;
    }
    return true;
  });
}
