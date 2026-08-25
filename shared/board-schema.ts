import { nanoid } from "nanoid";
import { z } from "zod";

import { DiagnosticsSnapshotSchema, emptyDiagnostics } from "./diagnostics-schema.ts";
import { AccountUsageSchema, AttentionMapSchema, EnvStateSchema, RecapSourceSchema, RecapStatusSchema, RegistryStatusSchema, SessionRowSchema, StatuslineDataSchema } from "./schema.ts";

export const ColumnTypeSchema = z.enum(["to-do", "in-progress", "closed"]);

export const ColumnSchema = z.object({
  id: z.string(),
  label: z.string(),
  // Optional semantic type. Only "closed" carries behavior (filtered out of the assign picker and
  // rendered as a collapsed vertical strip); legacy columns parse to `type: undefined` and behave
  // as normal untyped columns. `.optional()` (not a default) so exactOptionalPropertyTypes keeps
  // the field genuinely absent on untyped columns.
  type: ColumnTypeSchema.optional(),
});

export const PrioritySchema = z.enum(["p0", "p1", "p2", "p3"]).nullable();

export const SessionLinkSchema = z.object({
  env: z.string(),
  paneId: z.string(),
  tabId: z.string(),
  tabLabel: z.string(),
  workspaceId: z.string(),
  workspaceLabel: z.string(),
  name: z.string(),
  cwdSnapshot: z.string(),
  // The stable Claude session UUID (the live row's `agent_session`). Null for a link created before
  // Claude registered (spawn) — the reconciler backfills it — or when the herdr integration isn't
  // installed. Keyed on for churn-heal: after a herdr restart every paneId is reassigned, but a link
  // with a sessionId resolves to its current pane by matching this. Nullable+default (never
  // `.optional()`) so every link is uniformly `{ sessionId: string | null }` and legacy JSON heals on
  // parse — mirrors SessionRowSchema.sessionId.
  sessionId: z.string().nullable().default(null),
});

// Two families, and the split is load-bearing rather than cosmetic: `note` is the only kind a model
// writes, every other kind is stamped by corral on a route that already mutates the board, and the
// two carry SEPARATE quotas (server/task-log.ts) so a burst of lifecycle lines cannot evict the
// reasoning the log exists for.
export const LogKindSchema = z.enum([
  "created", "session_spawned", "session_bound", "session_closed", "session_detached", "status_changed",
  "note",
]);

/**
 * Who wrote the entry: a session, or corral/the operator acting directly.
 *
 * `sessionId` is NULLABLE for the same reason `SessionLinkSchema.sessionId` is — at spawn time
 * Claude has not registered yet, so a `session_spawned` entry cannot carry a uuid and a schema
 * demanding one would be unwritable exactly when it is most needed.
 *
 * `name` is a DISPLAY CAPTURE, not an address: it records what the canonical name resolution
 * returned when the entry was written (the live registry name, falling back to the link's stored
 * name), and nothing re-derives it later.
 */
export const LogSourceSchema = z.union([
  z.object({ sessionId: z.string().nullable().default(null), name: z.string() }),
  z.enum(["corral", "operator"]),
]);

/**
 * One entry's text ceiling, INCLUSIVE of the truncation marker — a stored entry is never longer than
 * this. A decision with its reasoning fits in 200–300.
 *
 * Here rather than beside the eviction logic that enforces it (server/task-log.ts) because the MCP
 * tool description states the number too, and `shared/` is the only module both sides may import:
 * reaching into `server/` from `mcp/` for one constant would drag the startup config loader into the
 * MCP process with it.
 */
export const LOG_ENTRY_TEXT_MAX = 800;

/**
 * The refusal for a note over the cap — one wording for the MCP tool and the route, naming the
 * overage so the writer shortens by that much and logs again. A note is REFUSED, never truncated:
 * a cut thought loses its conclusion, and a limit the writer is told about is one it can meet.
 * Truncation survives only for corral's own system entries (server/task-log.ts).
 */
export function logTooLong(length: number): string {
  return `note is ${String(length - LOG_ENTRY_TEXT_MAX)} characters over the ${String(LOG_ENTRY_TEXT_MAX)}-character limit — shorten it and log again; nothing was written`;
}

/**
 * SEPARATE quotas, and that is the whole point rather than a detail.
 *
 * A single shared cap would be actively harmful: moving a card into a closing column offers to close
 * every live session on it in one operator action, so a card with fifteen sessions produces a burst
 * of `session_closed` lines — under one cap that burst would evict exactly the notes the log exists
 * for. The `kind` filter lets a reader ignore the noise; only separate quotas stop the noise from
 * DELETING the signal. Enforced in server/task-log.ts; here because the board's Log tab names them.
 */
export const LOG_NOTE_QUOTA = 60;
export const LOG_SYSTEM_QUOTA = 140;

// STORED SHAPE — deliberately permissive on `text`, the same reasoning as SpawnPresetSchema and
// `description`: readBoardFile parses with BoardSchema, so a `.max()` here would turn an entry
// written before the cap existed into an unloadable board. The cap (LOG_ENTRY_TEXT_MAX) lives on
// the write path: a note over it is refused by the append route and the MCP tool, a system entry is
// truncated in server/task-log.ts.
export const LogEntrySchema = z.object({
  /**
   * A stable identity for one entry. `at` cannot serve as one: closing every session on a card is N
   * separate requests, each stamping its own clock read, and two can land in the same millisecond —
   * so a reader keying on the timestamp would collapse them.
   *
   * Added now rather than when a reader needs one, because this is data on disk: once entries exist
   * without an id, every reader carries a branch for them forever. The default is a FUNCTION so a
   * hand-edited entry missing the field still loads — that id is fresh on each parse rather than
   * stable, which is the honest answer for a value nobody wrote.
   */
  id: z.string().default(() => generateLogEntryId()),
  /**
   * Epoch MILLIS — unlike the task's `createdAt`/`updatedAt`, which are SECONDS (`nowSecs`).
   *
   * Deliberate: a burst of entries lands inside one second and the log is ordered, so second
   * resolution would erase the order it records. The mismatch is the trap, which is why it is stated
   * here and pinned by a test: `lastLogAtMs` (millis) sits beside `updatedAt` (seconds) on the same
   * object, and anything converting between them needs the factor of 1000.
   */
  atMs: z.number(),
  source: LogSourceSchema,
  kind: LogKindSchema,
  text: z.string(),
});

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  // Uncapped on purpose: the length guard belongs on the write paths (server/api.ts). A `.max()`
  // here would stop a board loading once it holds a description written before the guard existed.
  description: z.string().default(""),
  status: z.string(),
  priority: PrioritySchema.default(null),
  // No `repo`. A card cuts across workspaces — its sessions can sit in several repositories — so the
  // spawn target comes from the request, never from the card. A board written before this still
  // parses (z.object strips the unknown key) and loses the value on its next write.
  sessions: z.array(SessionLinkSchema).default([]),
  // The card's life, append-only: decisions and blockers produced between sessions inside a task
  // that has no PR to be commented on yet. `.default([])`, never `.optional()`, so a board file
  // written before this field heals on parse — the established pattern here (spawnPresets,
  // diagnostics). Deliberately absent from what rides the SSE frame: see TaskFrameSchema.
  log: z.array(LogEntrySchema).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/**
 * A task as it goes over the wire to the browser — everything but the log.
 *
 * `BoardState` is re-sent on every poll tick to every open board, so a growing log would be
 * retransmitted whole on each one. The log is fetched by a dedicated read when a card is opened;
 * the frame carries only `logCount`/`lastLogAtMs` (EnrichedTaskSchema) so the board can badge a card.
 *
 * This fixes the WIRE, not the parse: `buildUnassigned` re-reads and re-parses every board file on
 * every tick, and the log lives inside TaskSchema, so it is parsed there regardless. That cost is
 * knowingly accepted and bounded by the quotas in server/task-log.ts.
 */
export const TaskFrameSchema = TaskSchema.omit({ log: true });

// A start command the operator can pick when spawning from the UI. STORED SHAPE — deliberately
// permissive: readBoardFile uses BoardSchema.parse (server/storage.ts), so a content constraint here
// would turn a bad value into an unloadable board. Length, count and the leading-character rule live
// at the PATCH boundary (server/api.ts).
export const SpawnPresetSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
});

export const BoardSchema = z.object({
  id: z.string(),
  label: z.string(),
  columns: z.array(ColumnSchema),
  tasks: z.array(TaskSchema).default([]),
  // Defaults, never .optional(): a board written before these existed heals on parse, and every Board
  // value is uniformly shaped. A dangling defaultSpawnPresetId (matching no preset) is NOT resolved
  // here — that normalization lives only at the PATCH boundary (server/api.ts), so a board file
  // carrying a stale id still parses and loads with it.
  spawnPresets: z.array(SpawnPresetSchema).default([]),
  defaultSpawnPresetId: z.string().nullable().default(null),
});

export const LiveSessionDataSchema = z.object({
  status: z.string(),
  model: z.string().nullable(),
  ctxPct: z.string().nullable(),
  detached: z.boolean(),
  recap: z.string().nullable().default(null),
  recapAt: z.number().nullable().default(null),
  // Health of the recap read and which ladder rung produced the text. Both are what let the UI print a
  // REASON instead of an empty line — a board-linked session had neither, so for those the web could
  // not tell "nothing to show" from "the read is broken".
  recapStatus: RecapStatusSchema.nullable().default(null),
  recapSource: RecapSourceSchema.nullable().default(null),
  statusline: StatuslineDataSchema.nullable().default(null),
  // Claude's own state, projected from SessionRow. This schema is a CLOSED field list built
  // field-by-field in server/api.ts — a new SessionRow field that is not added in BOTH places never
  // reaches the web, and the omission is silent.
  claudeStatus: z.string().nullable().default(null),
  // Claude's own name for this session, straight from the registry. The card's title does NOT come
  // from here — server/api.ts resolves that into the link's `name`, gated on claudeNameUserSet. This
  // is the informational subtitle only, and is deliberately ungated: showing Claude's actual current
  // name, auto-derived or not, is the point of that line.
  claudeName: z.string().nullable().default(null),
  waitingFor: z.string().nullable().default(null),
  remoteControl: z.boolean().nullable().default(null),
  registryStatus: RegistryStatusSchema.nullable().default(null),
});

export const EnrichedSessionLinkSchema = SessionLinkSchema.extend({
  live: LiveSessionDataSchema.nullable(),
});

// Built on TaskFrameSchema, NOT on TaskSchema: extending the latter would inherit `log` silently and
// put the whole log back on every frame. The two counters are what the board's card badge reads
// (web/src/components/TaskCard.tsx) instead of the entries; "new since I looked" is derived from
// them per viewer in the browser (web/src/lib/log-seen.ts) — the server holds no seen notion.
export const EnrichedTaskSchema = TaskFrameSchema.extend({
  sessions: z.array(EnrichedSessionLinkSchema),
  logCount: z.number().default(0),
  // Notes only. Every card carries lifecycle entries from birth (`created`), so `logCount` cannot
  // say whether a session has written anything — this is what the badge's "nothing written" reads.
  noteCount: z.number().default(0),
  lastLogAtMs: z.number().nullable().default(null),
});

// The board-independent slice of a stream frame. `/api/stream` with no (or an unknown) board sends
// exactly this shape — NOT a bare Snapshot: the client parses every SSE frame with StreamFrameSchema
// and silently drops non-parsing ones, so a Snapshot frame would freeze the attention feed and the
// unassigned list on that view.
export const GlobalStateSchema = z.object({
  unassigned: z.array(SessionRowSchema),
  envs: z.record(z.string(), EnvStateSchema),
  attention: AttentionMapSchema, // .default({}) so a frame lacking it still parses
  accounts: z.array(AccountUsageSchema).default([]), // rides both frame shapes like attention
  // Rides both frame shapes: BoardStateSchema extends this one. `.default` keeps a frame without the
  // field parsing, exactly as `attention` and `accounts` do. The default is a FUNCTION: a plain object
  // would be handed out by reference to every frame that lacks the field.
  diagnostics: DiagnosticsSnapshotSchema.default(emptyDiagnostics),
});

// `board` carries its own copy of the task list (the web reads a count and the settings modal off
// it), so it needs the same log-free shape as `tasks` — otherwise the omit above buys nothing and
// every log still rides every tick. Parsing is unaffected either way: `log` heals to [] on the way
// back in.
export const BoardFrameSchema = BoardSchema.extend({
  tasks: z.array(TaskFrameSchema).default([]),
});

/**
 * Drop every task's log. ONE implementation for the two wire paths that must not carry it — the
 * stream frame and the board LIST — because they are far apart in server/api.ts and a second copy is
 * how one of them silently stops stripping. `GET /api/boards/:bid` deliberately does NOT use this:
 * the single-board read is where a card's log is fetched from.
 */
export function toBoardFrame(board: Board): BoardFrame {
  return { ...board, tasks: board.tasks.map(({ log: _log, ...rest }) => rest) };
}

export const BoardStateSchema = GlobalStateSchema.extend({
  board: BoardFrameSchema,
  tasks: z.array(EnrichedTaskSchema),
});

// Every `/api/stream` frame is one of these; BoardState first so a board frame keeps its board/tasks.
export const StreamFrameSchema = z.union([BoardStateSchema, GlobalStateSchema]);

export type Column = z.infer<typeof ColumnSchema>;
export type ColumnType = z.infer<typeof ColumnTypeSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type SessionLink = z.infer<typeof SessionLinkSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskFrame = z.infer<typeof TaskFrameSchema>;
export type LogKind = z.infer<typeof LogKindSchema>;
export type LogSource = z.infer<typeof LogSourceSchema>;
export type LogEntry = z.infer<typeof LogEntrySchema>;
export type Board = z.infer<typeof BoardSchema>;
export type BoardFrame = z.infer<typeof BoardFrameSchema>;
export type SpawnPreset = z.infer<typeof SpawnPresetSchema>;
export type LiveSessionData = z.infer<typeof LiveSessionDataSchema>;
export type EnrichedSessionLink = z.infer<typeof EnrichedSessionLinkSchema>;
export type EnrichedTask = z.infer<typeof EnrichedTaskSchema>;
export type GlobalState = z.infer<typeof GlobalStateSchema>;
export type BoardState = z.infer<typeof BoardStateSchema>;
export type StreamFrame = z.infer<typeof StreamFrameSchema>;

export const DEFAULT_COLUMNS: readonly Column[] = [
  { id: "todo", label: "Todo", type: "to-do" },
  { id: "doing", label: "Doing", type: "in-progress" },
  { id: "blocked", label: "Blocked", type: "in-progress" },
  { id: "done", label: "Done", type: "closed" },
] as const;

const PRIORITY_ORDER: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

export function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const pa = a.priority !== null ? (PRIORITY_ORDER[a.priority] ?? 4) : 4;
    const pb = b.priority !== null ? (PRIORITY_ORDER[b.priority] ?? 4) : 4;
    if (pa !== pb) return pa - pb;
    // Within a priority: newest first (createdAt DESC) — a freshly created/moved task surfaces at
    // the top of its column rather than sinking to the bottom.
    return b.createdAt - a.createdAt;
  });
}

export function slugifyBoardId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "board";
}

export function generateTaskId(): string {
  return `t_${nanoid(7)}`;
}

// Short: it identifies an entry within one card's log, never across boards — unlike a task id, which
// is a REST path segment.
export function generateLogEntryId(): string {
  return nanoid(8);
}

export function generateColumnId(): string {
  return nanoid(8);
}

// A preset's id is what defaultSpawnPresetId points at, so it must survive editing the text — the same
// reason ColumnSchema carries an id and tasks key on it rather than on the label.
export function generateSpawnPresetId(): string {
  return nanoid(8);
}

// Ids of columns typed "closed". Used to (a) hide closed tasks in the assign-to-task picker and
// (b) render those columns as collapsed vertical strips on the board.
export function closedColumnIds(columns: readonly Column[]): Set<string> {
  return new Set(columns.filter((c) => c.type === "closed").map((c) => c.id));
}

/**
 * Where a task lands when nothing else decides: the first column that is not `closed`.
 *
 * INVARIANT — a task's landing status is always `defaultColumnId` of its board. Position 0 is NOT
 * the default: a `closed` column renders as a collapsed strip, so a task landing there is invisible,
 * and one dropdown change in Board settings puts a closed column at position 0. Falls back to
 * `columns[0]` when every column is closed (a board with nowhere open to land — the operator's
 * choice, and there is no better answer), and to `undefined` on an empty board.
 */
export function defaultColumnId(columns: readonly Column[]): string | undefined {
  return (columns.find((c) => c.type !== "closed") ?? columns[0])?.id;
}

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}
