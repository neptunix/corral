import { z } from "zod";

import { PrioritySchema } from "./board-schema.ts";

// The whoami composite deliberately lives in its own module: it needs both session shapes
// (schema.ts) and card shapes (board-schema.ts), and board-schema.ts already imports schema.ts —
// putting the composite in schema.ts would create an import cycle.

export const WhoamiEnvSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["local", "remote"]),
  reachable: z.boolean(),
});

// One row per session attached to the card. `key` is `${env}:${paneId}` — the same format as the
// attention-map key and the value `corral_session_close` accepts as a target.
export const WhoamiCardSessionSchema = z.object({
  /** The LINK's name — what the card is labelled with, i.e. the name corral was asked for. */
  name: z.string(),
  /**
   * The name the Claude session itself answers to, when the statusline has been captured. It is NOT
   * always `name`: a resumed session is launched without `--name` and derives its own from the cwd,
   * so the card can read `s0-orchestrator-spec` while the session is really `github-private-e5`.
   * Null when unknown, which is not the same as "equal to name".
   *
   * Defaulted, not required: an MCP client talks to whatever corral server is already running, and a
   * server predating this field would otherwise fail validation on EVERY card read rather than lose
   * one informational string.
   */
  claudeName: z.string().nullable().default(null),
  key: z.string(),
  sessionId: z.string().nullable(),
  status: z.string(),
  detached: z.boolean(),
  ctxPct: z.number().nullable(),
  self: z.boolean(),
});

export const WhoamiColumnSchema = z.object({ id: z.string(), label: z.string() });

export const WhoamiTaskSchema = z.object({
  boardId: z.string(),
  boardLabel: z.string(),
  taskId: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.string(),
  priority: PrioritySchema,
  // Load-bearing: board columns are configurable, so a status write must pick from these ids
  // rather than assume the DEFAULT_COLUMNS values.
  columns: z.array(WhoamiColumnSchema),
  sessions: z.array(WhoamiCardSessionSchema),
});

export const WhoamiSessionSchema = z.object({
  env: z.string(),
  envLabel: z.string(),
  paneId: z.string(),
  tabId: z.string(),
  tabLabel: z.string(),
  workspaceId: z.string(),
  workspaceLabel: z.string(),
  sessionId: z.string().nullable(),
  sessionName: z.string().nullable(),
  cwd: z.string(),
  status: z.string(),
  model: z.string().nullable(),
  ctxPct: z.number().nullable(),
  costUsd: z.number().nullable(),
  fiveHourPct: z.number().nullable(),
  sevenDayPct: z.number().nullable(),
  account: z.string().nullable(),
});

export const WhoamiResolvedSchema = z.object({
  resolved: z.literal(true),
  session: WhoamiSessionSchema,
  task: WhoamiTaskSchema.nullable(),
  envs: z.array(WhoamiEnvSchema),
});

export const WhoamiUnresolvedSchema = z.object({
  resolved: z.literal(false),
  reason: z.string(),
  envs: z.array(WhoamiEnvSchema),
});

export const WhoamiResponseSchema = z.discriminatedUnion("resolved", [
  WhoamiResolvedSchema,
  WhoamiUnresolvedSchema,
]);

export type WhoamiEnv = z.infer<typeof WhoamiEnvSchema>;
export type WhoamiCardSession = z.infer<typeof WhoamiCardSessionSchema>;
export type WhoamiColumn = z.infer<typeof WhoamiColumnSchema>;
export type WhoamiTask = z.infer<typeof WhoamiTaskSchema>;
export type WhoamiSession = z.infer<typeof WhoamiSessionSchema>;
export type WhoamiResolved = z.infer<typeof WhoamiResolvedSchema>;
export type WhoamiResponse = z.infer<typeof WhoamiResponseSchema>;
