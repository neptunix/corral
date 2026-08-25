import { normalizeLinkName } from "./link-name.ts";
import { buildLiveIndex, resolveLiveRow } from "./live-resolve.ts";
import { linkBindsSession } from "./session-binding.ts";
import type { Board, LogEntry, LogKind, LogSource, SessionLink, Task } from "../shared/board-schema.ts";
import { generateLogEntryId, LOG_ENTRY_TEXT_MAX, LOG_NOTE_QUOTA, LOG_SYSTEM_QUOTA } from "../shared/board-schema.ts";
import type { SessionRow } from "../shared/schema.ts";

// Defined in shared/ (the board's Log tab prints them); re-exported so this stays their server home.
export { LOG_NOTE_QUOTA, LOG_SYSTEM_QUOTA };

function isNote(entry: LogEntry): boolean {
  return entry.kind === "note";
}

function quotaFor(kind: LogKind): number {
  return kind === "note" ? LOG_NOTE_QUOTA : LOG_SYSTEM_QUOTA;
}

function capText(text: string): string {
  if (text.length <= LOG_ENTRY_TEXT_MAX) return text;
  // Cutting by code unit can land between the two halves of a surrogate pair (an emoji, most CJK
  // extensions) and store a lone surrogate in the board file. It survives JSON, but every reader
  // downstream then holds half a character. Step back one unit when the cut lands on a high
  // surrogate — at most one character shorter than the cap, never longer.
  const end = LOG_ENTRY_TEXT_MAX - 1;
  const lastCode = text.charCodeAt(end - 1);
  const cut = lastCode >= 0xd800 && lastCode <= 0xdbff ? end - 1 : end;
  return `${text.slice(0, cut)}…`;
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
 * The log's account of one stored link: the session's own registry name when the registry has
 * answered, else the link's stored name; the live uuid, else the link's (null before the reconciler
 * backfills it — the spawn-time shape the schema exists to admit).
 *
 * `name` is deliberately UNGATED by `claudeNameUserSet`, unlike every value that gets pushed onto a
 * label: the log records what the session was called when it wrote, and a derived name is the honest
 * answer to that. It is still normalized, because it is stored.
 */
function sourceForLink(link: SessionLink, sessions: readonly SessionRow[]): LogSource {
  const row = resolveLiveRow(link, buildLiveIndex(sessions));
  const claudeName = row?.claudeName === null || row?.claudeName === undefined ? "" : normalizeLinkName(row.claudeName);
  return {
    sessionId: row?.sessionId ?? link.sessionId,
    name: claudeName !== "" ? claudeName : link.name,
  };
}

/**
 * Who a pane is, for the purposes of one log entry — resolved from the links on the target card
 * first, then from every card on every board. Null when the pane is bound nowhere: a writer must be
 * a session on SOME card, because that is where its name comes from. Which card it writes to is the
 * invariant's business, not this function's — a session may append to any card.
 *
 * The identity rule is REUSED, never re-derived: `linkBindsSession` decides which stored link is this
 * pane's, and `resolveLiveRow` finds that link's live row — the same pair whoami's card block and the
 * board frame use. A fourth local copy of this rule is exactly what bit the fleet digest.
 *
 * The target card's own links come first, and it matters: `boards` may be a snapshot read outside the
 * target board's lock, so the link the write lands beside is the fresh one.
 */
export function resolveLogSource(
  task: Task,
  boards: readonly Board[],
  pane: { readonly env: string; readonly paneId: string },
  sessions: readonly SessionRow[],
): LogSource | null {
  const groups = [{ sessions: task.sessions }, ...boards.flatMap((b) => b.tasks)];
  return resolveWriter(groups, pane, sessions);
}

/**
 * The writer for a pane, resolved across whatever link-carrying groups are handed in — every card on
 * every board (a create names its creator that way, with no target card yet), or a single card first
 * (the append path, so a just-attached link wins). Null when the pane binds nothing anywhere.
 */
export function resolveWriter(
  groups: readonly { readonly sessions: readonly SessionLink[] }[],
  pane: { readonly env: string; readonly paneId: string },
  sessions: readonly SessionRow[],
): LogSource | null {
  const live = sessions.find((s) => s.env === pane.env && s.paneId === pane.paneId);
  const incoming = { env: pane.env, paneId: pane.paneId, liveSessionId: live?.sessionId ?? null };
  const link = groups.flatMap((g) => g.sessions).find((l) => linkBindsSession(l, incoming));
  return link === undefined ? null : sourceForLink(link, sessions);
}

/**
 * Stamp one of corral's own lifecycle entries on a task. Called INSIDE the board's `withBoard`
 * callback, so the clock is read under the same lock that orders the entries.
 */
export function stampSystem(task: Task, kind: Exclude<LogKind, "note">, text: string): Task {
  // `source` is always the literal `corral`: a lifecycle entry is corral recording its own action,
  // and the session it concerns is named in `text` via sessionRef, not in the source.
  const entry: LogEntry = { id: generateLogEntryId(), atMs: Date.now(), source: "corral", kind, text };
  return { ...task, log: appendLogEntry(task.log, entry) };
}

/** The line a lifecycle entry names a session with: its card label and its fleet-wide key. */
export function sessionRef(link: { readonly name: string; readonly env: string; readonly paneId: string }): string {
  return `${link.name} (${link.env}:${link.paneId})`;
}
