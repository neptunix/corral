import { normalizeLinkName } from "./link-name.ts";
import { buildLiveIndex, resolveLiveRow } from "./live-resolve.ts";
import { linkBindsSession } from "./session-binding.ts";
import type { LogEntry, LogKind, LogSource, Task } from "../shared/board-schema.ts";
import { LOG_ENTRY_TEXT_MAX } from "../shared/board-schema.ts";
import type { SessionRow } from "../shared/schema.ts";

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

/**
 * Who a pane is, for the purposes of one log entry — resolved from the card the entry lands on, not
 * from anything the caller sent. Returns null when the pane is not bound to this card: a session may
 * write only on its own card.
 *
 * The identity rule is REUSED, never re-derived: `linkBindsSession` decides which stored link is this
 * pane's, and `resolveLiveRow` finds that link's live row — the same pair whoami's card block and the
 * board frame use. A fourth local copy of this rule is exactly what bit the fleet digest.
 *
 * `name` prefers the session's own registry name and is deliberately UNGATED by `claudeNameUserSet`,
 * unlike every value that gets pushed onto a label: the log records what the session was called when
 * it wrote, and a derived name is the honest answer to that. It is still normalized, because it is
 * stored. `sessionId` may be null — at spawn time Claude has not registered yet.
 */
export function resolveLogSource(
  task: Task,
  pane: { readonly env: string; readonly paneId: string },
  sessions: readonly SessionRow[],
): LogSource | null {
  const index = buildLiveIndex(sessions);
  const live = sessions.find((s) => s.env === pane.env && s.paneId === pane.paneId);
  const incoming = { env: pane.env, paneId: pane.paneId, liveSessionId: live?.sessionId ?? null };
  const link = task.sessions.find((l) => linkBindsSession(l, incoming));
  if (link === undefined) return null;
  const row = resolveLiveRow(link, index);
  const claudeName = row?.claudeName === null || row?.claudeName === undefined ? "" : normalizeLinkName(row.claudeName);
  return {
    sessionId: row?.sessionId ?? link.sessionId,
    name: claudeName !== "" ? claudeName : link.name,
  };
}
