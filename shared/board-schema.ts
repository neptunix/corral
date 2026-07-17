import { nanoid } from "nanoid";
import { z } from "zod";

import { AccountUsageSchema, AttentionMapSchema, EnvStateSchema, SessionRowSchema, StatuslineDataSchema } from "./schema.ts";

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

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().default(""),
  status: z.string(),
  priority: PrioritySchema.default(null),
  repo: z.string().nullable().default(null),
  sessions: z.array(SessionLinkSchema).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const BoardSchema = z.object({
  id: z.string(),
  label: z.string(),
  columns: z.array(ColumnSchema),
  tasks: z.array(TaskSchema).default([]),
});

export const LiveSessionDataSchema = z.object({
  status: z.string(),
  model: z.string().nullable(),
  ctxPct: z.string().nullable(),
  detached: z.boolean(),
  recap: z.string().nullable().default(null),
  recapAt: z.number().nullable().default(null),
  statusline: StatuslineDataSchema.nullable().default(null),
});

export const EnrichedSessionLinkSchema = SessionLinkSchema.extend({
  live: LiveSessionDataSchema.nullable(),
});

export const EnrichedTaskSchema = TaskSchema.extend({
  sessions: z.array(EnrichedSessionLinkSchema),
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
});

export const BoardStateSchema = GlobalStateSchema.extend({
  board: BoardSchema,
  tasks: z.array(EnrichedTaskSchema),
});

// Every `/api/stream` frame is one of these; BoardState first so a board frame keeps its board/tasks.
export const StreamFrameSchema = z.union([BoardStateSchema, GlobalStateSchema]);

export type Column = z.infer<typeof ColumnSchema>;
export type ColumnType = z.infer<typeof ColumnTypeSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type SessionLink = z.infer<typeof SessionLinkSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Board = z.infer<typeof BoardSchema>;
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

export function generateColumnId(): string {
  return nanoid(8);
}

// Ids of columns typed "closed". Used to (a) hide closed tasks in the assign-to-task picker and
// (b) render those columns as collapsed vertical strips on the board.
export function closedColumnIds(columns: readonly Column[]): Set<string> {
  return new Set(columns.filter((c) => c.type === "closed").map((c) => c.id));
}

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}
