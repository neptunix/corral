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
   * The name the Claude session itself answers to, read live from its registry. It is NOT always
   * `name`: a resumed session is launched without `--name` and derives its own from the cwd, so the
   * card can read `s0-orchestrator-spec` while the session is really `github-private-e5`.
   * Null when there is no registry record for the pane, which is not the same as "equal to name".
   *
   * Deliberately UNGATED, unlike every value that gets stored or pushed onto a label: this one is only
   * displayed, and reporting what Claude currently calls the session — auto-derived or not — is the
   * whole point of the field.
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

// `closed` marks a column that ENDS the work: the session must tell one apart before writing
// `status`, and ids and labels alone cannot. Defaulted, not optional, so a corral server older than
// this field still parses — such a server renders every column as open, which is the pre-marker
// behaviour rather than a new failure.
export const WhoamiColumnSchema = z.object({ id: z.string(), label: z.string(), closed: z.boolean().default(false) });

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
  /**
   * The log's SIZE, not its entries — whoami is the first and most repeated call, and the skill
   * routes a session from it into corral_task_read. Without a count here a session cannot tell a card
   * carrying 37 entries from an empty one, and would either read every card's log or none of them.
   *
   * This is a separate closed schema from EnrichedTask, so the counters added to the stream frame do
   * NOT reach it — they have to be added here as well or whoami silently loses them.
   *
   * Defaulted, not required, for the same reason as `claudeName` and the closing-column marker: an
   * MCP client talks to whatever corral server is already running, and one predating this field would
   * otherwise fail validation on every card read.
   */
  logCount: z.number().default(0),
  lastLogAtMs: z.number().nullable().default(null),
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
  /**
   * The name to STORE for this session — gated on `claudeNameUserSet`, because the MCP attach writes
   * it into `SessionLink.name`, which outlives the session and which the reconciler refreshes only for
   * user-set names. Null when Claude named the session itself: the card should not inherit that.
   * For DISPLAY use `claudeName` below, which is what the session actually answers to.
   */
  sessionName: z.string().nullable(),
  /**
   * What Claude currently calls this session, ungated — the address a peer uses. Mirrors
   * `WhoamiCardSession.claudeName`, and deliberately shows an auto-derived name: a session resumed
   * without `--name` derives its own, and telling it its name was "not captured" would send it to hand
   * out its tab label, which for a resumed session is the slugified card name and not an address.
   *
   * Defaulted, not required: an MCP client talks to whatever corral server is already running.
   */
  claudeName: z.string().nullable().default(null),
  cwd: z.string(),
  status: z.string(),
  model: z.string().nullable(),
  ctxPct: z.number().nullable(),
  costUsd: z.number().nullable(),
  fiveHourPct: z.number().nullable(),
  sevenDayPct: z.number().nullable(),
  account: z.string().nullable(),
  /** Remote Control, for corral_spawn to inherit. Null is no registry record — unknown, not off. */
  remoteControl: z.boolean().nullable(),
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
