import { z } from "zod";

export const EnvStateSchema = z.object({
  reachable: z.boolean(),
  error: z.string().optional(),
  // Static env kind (from trusted config). Optional on the wire so legacy/partial payloads and existing
  // fixtures stay valid; the poller always populates it. The web uses it to offer file-drop on local only.
  kind: z.enum(["local", "remote"]).optional(),
  // Operator-facing display name from the trusted env config (environments.ts `label`). Optional on the
  // wire like `kind` so legacy/partial payloads and fixtures stay valid; the poller always populates it.
  // The web shows it in place of the raw env id (routing still keys on the id).
  label: z.string().optional(),
});

export const RecapStatusSchema = z.enum(["ok", "no-session-ref", "not-found", "no-summary", "read-error"]);

export const RateWindowSchema = z.object({
  used_percentage: z.number(),
  resets_at: z.number(),
});

export const StatuslineAccountSchema = z.object({
  uuid: z.string().nullable(),
  email: z.string().nullable(),
  org: z.string().nullable(),
  tier: z.string().nullable(),
});

export const StatuslineDataSchema = z.object({
  v: z.literal(1),
  captured_at: z.number(),
  session_id: z.string(),
  session_name: z.string().nullable(),
  account: StatuslineAccountSchema.nullable(),
  model: z.string().nullable(),
  model_id: z.string().nullable(),
  ctx: z.object({ pct: z.number().nullable(), tokens: z.number().nullable(), window: z.number().nullable() }),
  cost: z.object({ usd: z.number().nullable(), lines_added: z.number().nullable(), lines_removed: z.number().nullable() }),
  rate: z.object({ five_hour: RateWindowSchema.nullable(), seven_day: RateWindowSchema.nullable() }),
  effort: z.string().nullable(),
  thinking: z.boolean().nullable(),
  cc_version: z.string().nullable(),
});

export const StatuslineStatusSchema = z.enum(["ok", "no-session-ref", "not-found", "bad-schema", "read-error"]);

export const AccountUsageSchema = z.object({
  uuid: z.string(),
  email: z.string().nullable(),
  org: z.string().nullable(),
  tier: z.string().nullable(),
  fiveHour: RateWindowSchema.nullable(),
  sevenDay: RateWindowSchema.nullable(),
  capturedAt: z.number(),
  envIds: z.array(z.string()),
});

export const SessionRowSchema = z.object({
  env: z.string(),
  paneId: z.string(),
  status: z.string(),
  agent: z.string(),
  cwd: z.string(),
  tab: z.string(),
  workspace: z.string(),
  // Stable herdr ids behind the labels. Persisted onto a SessionLink at attach/from-session so a later
  // close/resume has real coordinates (labels alone can't address a tab), and so close can heal a
  // legacy empty-id link from the live row. Optional: a live row from `listSessions` always carries
  // them, but they're absent on legacy payloads → `undefined` (consumers fall back).
  tabId: z.string().optional(),
  workspaceId: z.string().optional(),
  sessionId: z.string().nullable().default(null),
  recap: z.string().nullable().default(null),
  recapAt: z.number().nullable().default(null),
  recapStatus: RecapStatusSchema.nullable().default(null),
  statusline: StatuslineDataSchema.nullable().default(null),
  statuslineStatus: StatuslineStatusSchema.nullable().default(null),
});

export const SnapshotSchema = z.object({
  envs: z.record(z.string(), EnvStateSchema),
  sessions: z.array(SessionRowSchema),
});

export const PaneReadSchema = z.object({
  text: z.string(),
  ctxPct: z.string().nullable(),
  model: z.string().nullable(),
  sessionName: z.string().nullable(),
});

export const AttentionStateSchema = z.enum(["blocked", "finished"]);

export const AttentionRecordSchema = z.object({
  state: AttentionStateSchema,
  since: z.number(),
  sessionName: z.string().nullable(),
  lastLines: z.string(),
  captured: z.boolean(),
});

export const AttentionMapSchema = z.record(z.string(), AttentionRecordSchema).default({});

// Body for POST /api/boards/:bid/tasks/:tid/move — relocate a task to another board.
export const MoveTaskRequestSchema = z.object({ toBoardId: z.string() });

// Response of POST /api/envs/:env/uploads — the absolute on-host path the dropped bytes were written to.
export const UploadResponseSchema = z.object({ path: z.string() });

// Single source of truth for the drop-upload byte cap: the server enforces it (pre-buffer, via
// hono/body-limit) and the web pre-checks against it, so client and server limits cannot drift.
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export type EnvState = z.infer<typeof EnvStateSchema>;
export type RecapStatus = z.infer<typeof RecapStatusSchema>;
export type SessionRow = z.infer<typeof SessionRowSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type PaneRead = z.infer<typeof PaneReadSchema>;
export type AttentionState = z.infer<typeof AttentionStateSchema>;
export type AttentionRecord = z.infer<typeof AttentionRecordSchema>;
export type AttentionMap = z.infer<typeof AttentionMapSchema>;
export type MoveTaskRequest = z.infer<typeof MoveTaskRequestSchema>;
export type UploadResponse = z.infer<typeof UploadResponseSchema>;
export type RateWindow = z.infer<typeof RateWindowSchema>;
export type StatuslineData = z.infer<typeof StatuslineDataSchema>;
export type StatuslineStatus = z.infer<typeof StatuslineStatusSchema>;
export type AccountUsage = z.infer<typeof AccountUsageSchema>;
