import { z } from "zod";

/**
 * `state` and `severity` are separate on purpose. Collapsing them puts `info` in the same enum as
 * `pending`, and then "checking…" competes with "there is a recommendation" for the rail's one number.
 * `severity` is meaningful only when `state === "problem"`.
 */
export const CheckStateSchema = z.enum(["ok", "problem", "pending", "n/a"]);
export const CheckSeveritySchema = z.enum(["info", "warning", "fatal"]);
/**
 * Cost class, not subject — it decides cadence AND storage granularity. `versions` is separate from
 * `cheap` because it carries its own TTL and the store replaces a class wholesale: filed under
 * `cheap`, those rows would vanish and reappear on every 60-second sweep.
 */
export const CheckClassSchema = z.enum(["cheap", "versions", "remote", "network"]);

export const CheckScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("env"), envId: z.string() }),
  z.object({ kind: z.literal("configDir"), envId: z.string(), dir: z.string() }),
]);

export const CheckDocSchema = z.object({ anchor: z.string(), title: z.string() });

export const CheckSchema = z.object({
  /** WHAT was checked. Stable across scopes, so a README link and a test name never move. */
  id: z.string(),
  /** id + scope. Unique within a snapshot: the React key and stage 2's auto-expand signature key. */
  key: z.string(),
  title: z.string(),
  state: CheckStateSchema,
  severity: CheckSeveritySchema,
  detail: z.string(),
  doc: CheckDocSchema.nullable(),
  scope: CheckScopeSchema,
  class: CheckClassSchema,
  checkedAt: z.number().nullable(),
  /** Print a ✓ line at startup when healthy. False keeps the launch report from ballooning. */
  startupOkLine: z.boolean(),
  /** Refuse the launch when this check is a problem — and the source of the printed mark. */
  haltsStartup: z.boolean(),
});

export const RollupSchema = z.object({
  fatal: z.number(), warning: z.number(), info: z.number(), pending: z.number(),
});

/**
 * The repo-INDEPENDENT half of the release-URL rule — all this file can express, because it ships in
 * the browser bundle and cannot read `package.json`. The `/<owner>/<repo>/` prefix is enforced by the
 * producer (`server/diagnostics/update/check.ts`), which is where that knowledge lives.
 */
export function isReleaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.host === "github.com";
  } catch {
    return false;
  }
}

/** Optional leading `v`, dotted digits, bounded. A prerelease or a word tag is not comparable. */
export function isStableTag(value: string): boolean {
  return value.length <= 32 && /^v?\d+(?:\.\d+){0,3}$/.test(value);
}

/**
 * DEGRADING on purpose: ANYTHING that is not a conforming string — a hostile url, the wrong type, an
 * absent field — becomes `null`, and the parse never fails. Rejecting would discard the WHOLE frame
 * — sessions, envs, attention and the board — because this schema is nested inside
 * `GlobalStateSchema` (see `web/src/useEventSource.ts`). A bad value must cost the link, not the
 * dashboard. `z.unknown()` and not `z.string().nullable()`, because the latter rejects a non-string
 * BEFORE the transform runs, which is the one case the degradation exists for.
 */
export const ReleaseUrlSchema = z.unknown()
  .transform((v) => (typeof v === "string" && isReleaseUrl(v) ? v : null));

/** Same contract as `ReleaseUrlSchema`: the panel renders `latest` as the anchor's own text. */
export const LatestTagSchema = z.unknown()
  .transform((v) => (typeof v === "string" && isStableTag(v) ? v : null));

export const SelfInfoSchema = z.object({
  version: z.string().nullable(),
  latest: LatestTagSchema,
  releaseUrl: ReleaseUrlSchema,
});

export const DiagnosticsSnapshotSchema = z.object({
  checks: z.array(CheckSchema),
  /**
   * Which cost classes have produced a result at least once. An empty snapshot's rollup is all zeros,
   * which reads as a clean bill of health — the exact lie this feature exists to remove. The rail
   * needs to tell "nothing is wrong" from "nothing has run yet", and per-check `pending` cannot say
   * that when there are no checks at all.
   */
  answered: z.array(CheckClassSchema),
  /**
   * The last sweep failure, or null. Without it a sweep that throws on every tick is invisible on the
   * wire: the store deliberately keeps the previous results, so the snapshot goes on publishing stale
   * rows that read as current. One nullable string is the difference between a panel that is quiet and
   * a panel that lies.
   */
  lastError: z.string().nullable(),
  self: SelfInfoSchema,
});

export type CheckState = z.infer<typeof CheckStateSchema>;
export type CheckSeverity = z.infer<typeof CheckSeveritySchema>;
export type CheckClass = z.infer<typeof CheckClassSchema>;
export type CheckScope = z.infer<typeof CheckScopeSchema>;
export type CheckDoc = z.infer<typeof CheckDocSchema>;
export type Check = z.infer<typeof CheckSchema>;
export type Rollup = z.infer<typeof RollupSchema>;
export type SelfInfo = z.infer<typeof SelfInfoSchema>;
export type DiagnosticsSnapshot = z.infer<typeof DiagnosticsSnapshotSchema>;

/**
 * The row's identity. One subject legitimately repeats across scopes; the id must not.
 *
 * `suffix` covers the one case scope cannot: two global rows of the same subject, which is exactly
 * `bin-on-path` with both `herdr` and `ssh` missing. The id stays the stable README/test key.
 */
export function checkKey(id: string, scope: CheckScope, suffix?: string): string {
  const tail = suffix === undefined ? "" : `#${suffix}`;
  if (scope.kind === "global") return `${id}${tail}`;
  if (scope.kind === "env") return `${id}@${scope.envId}${tail}`;
  return `${id}@${scope.envId}:${scope.dir}${tail}`;
}

export function computeRollup(checks: readonly Check[]): Rollup {
  const r = { fatal: 0, warning: 0, info: 0, pending: 0 };
  for (const c of checks) {
    if (c.state === "pending") { r.pending += 1; continue; }
    if (c.state !== "problem") continue;
    if (c.severity === "fatal") r.fatal += 1;
    else if (c.severity === "warning") r.warning += 1;
    else r.info += 1;
  }
  return r;
}

export const EMPTY_DIAGNOSTICS: DiagnosticsSnapshot = {
  checks: [],
  answered: [],
  lastError: null,
  self: { version: null, latest: null, releaseUrl: null },
};

/**
 * A FRESH empty snapshot. This is what the schema default must call, not `EMPTY_DIAGNOSTICS` itself:
 * zod returns the same object for a non-function default, so every frame parsed without the field
 * would alias one mutable snapshot — and stage 2 sorts and groups `checks` in place.
 * (`Object.freeze` is not the fix here: it would type `checks` as `readonly never[]`, which cannot be
 * assigned to `Check[]`, and this repo forbids type assertions.)
 */
export const emptyDiagnostics = (): DiagnosticsSnapshot => structuredClone(EMPTY_DIAGNOSTICS);
