import type { Check, DiagnosticsSnapshot, Rollup } from "@shared/diagnostics-schema";

/**
 * The newest timestamp among SERVER-BACKED checks, or null when none carries one.
 *
 * Synthetic client checks (see `syntheticChecks`) deliberately carry `checkedAt: null` so they can
 * never freshen this number: the header prints it as "last checked", and a dead backend reading
 * "checked just now" over rows that are minutes stale is the exact lie this feature removes.
 */
export function maxCheckedAt(checks: readonly Check[]): number | null {
  let best: number | null = null;
  for (const c of checks) {
    if (c.checkedAt === null) continue;
    if (best === null || c.checkedAt > best) best = c.checkedAt;
  }
  return best;
}

/**
 * Which snapshot the rail renders. ONE slot, fed by both the SSE frame and the Recheck response, so
 * the badge digit and the rows it summarizes are the same value by construction.
 *
 * `incoming === null` means THE CARRIER IS ABSENT — no frame and no seed, which happens on every
 * board switch — and absence is not news. Anything non-null came from a live server and is compared.
 * Keeping those two cases apart is what makes the rest of this function a plain "strictly newer wins":
 * collapsing them (rev 1 did) makes the board-switch hold impossible, because a cleared frame and a
 * server that has swept nothing become the same value and the blank one always wins.
 *
 * A tie keeps the incumbent, so a redelivered sweep does not churn the panel. An incoming snapshot
 * with no timestamps still wins: that is a restarted server publishing `checks: []` until its first
 * sweep lands, and pinning pre-restart rows with nothing marking them stale is the worse failure.
 */
export function pickSnapshot(
  held: DiagnosticsSnapshot,
  incoming: DiagnosticsSnapshot | null,
): DiagnosticsSnapshot {
  if (incoming === null) return held;
  const heldAt = maxCheckedAt(held.checks);
  const incomingAt = maxCheckedAt(incoming.checks);
  if (heldAt === null || incomingAt === null) return incoming;
  return incomingAt > heldAt ? incoming : held;
}

/** The view-only group synthetic rows are lifted into; `CheckScope` has no "client" kind to express it. */
const SYNTHETIC_GROUP_KEY = "client";
const SYNTHETIC_IDS = new Set(["backend-unreachable", "sweep-failed"]);

/**
 * Conditions the server's own rollup structurally cannot report: the panel cannot be a server check
 * about the server whose death it reports, and a sweep that throws cannot file a report about itself.
 * Both are minted as ordinary `Check` values so they flow through ONE code path into grouping, the
 * rollup, the badge digit and the auto-open trigger.
 *
 * `scope` and `class` are forced to existing enum members because the wire schema is frozen this
 * stage; the grouper lifts these two ids out by id, not by scope.
 */
export function syntheticChecks(snapshot: DiagnosticsSnapshot, streamDown: boolean): Check[] {
  const rows: Check[] = [];
  const base = {
    state: "problem", severity: "fatal", doc: null,
    scope: { kind: "global" }, class: "network",
    checkedAt: null, startupOkLine: false, haltsStartup: false,
  } as const;
  if (streamDown) {
    rows.push({
      ...base, id: "backend-unreachable", key: "backend-unreachable",
      title: "corral is not answering",
      detail: "The dashboard lost its connection to the corral server. Every row below predates the "
        + "disconnect. The page keeps retrying on its own.",
    });
  }
  if (snapshot.lastError !== null) {
    rows.push({
      ...base, id: "sweep-failed", key: "sweep-failed",
      title: "the diagnostics sweep is failing",
      detail: `The last sweep threw and the rows below are the previous run's: ${snapshot.lastError}`,
    });
  }
  return rows;
}

/** Server checks plus synthetics — the single list every derived value reads (badge, header, age). */
export function renderedChecks(snapshot: DiagnosticsSnapshot, streamDown: boolean): Check[] {
  return [...syntheticChecks(snapshot, streamDown), ...snapshot.checks];
}

export type HeaderStatus = "checking" | "ok" | "info" | "warning" | "fatal";

/**
 * The header's one-word verdict. Reads the ROLLUP, never raw rows: `computeRollup` is what enforces
 * "severity is meaningful only when state === 'problem'" — a row's `severity` field can be set
 * regardless of `state`, so ranking rows directly (instead of the rollup) risks a non-problem row's
 * severity painting a healthy install red.
 *
 * `checking` needs both conditions. An empty row set with an answered class is not "nothing has run
 * yet": the store records that an empty array for an answered class is still an answer.
 */
export function headerStatus(rollup: Rollup, answeredCount: number, renderedCount: number): HeaderStatus {
  if (renderedCount === 0 && answeredCount === 0) return "checking";
  if (rollup.fatal > 0) return "fatal";
  if (rollup.warning > 0) return "warning";
  if (rollup.info > 0) return "info";
  return "ok";
}

/** The red digit. `info` is a recommendation, not a problem, and `pending` is not an answer. */
export function badgeCount(rollup: Rollup): number {
  return rollup.fatal + rollup.warning;
}

export interface CheckGroup {
  readonly key: string;
  readonly label: string;
  /** Rendered in full — the only rows the operator can act on. */
  readonly problems: readonly Check[];
  readonly ok: readonly Check[];
  readonly na: readonly Check[];
  readonly pending: readonly Check[];
}

const SEVERITY_RANK = { fatal: 0, warning: 1, info: 2 } as const;

function groupKeyOf(c: Check): string {
  if (SYNTHETIC_IDS.has(c.id)) return SYNTHETIC_GROUP_KEY;
  if (c.scope.kind === "global") return "global";
  if (c.scope.kind === "env") return `env:${c.scope.envId}`;
  return `dir:${c.scope.envId}:${c.scope.dir}`;
}

function groupLabelOf(c: Check, labelFor: (envId: string) => string): string {
  if (SYNTHETIC_IDS.has(c.id)) return "This browser";
  if (c.scope.kind === "global") return "corral";
  if (c.scope.kind === "env") return labelFor(c.scope.envId);
  return `${labelFor(c.scope.envId)} · ${c.scope.dir}`;
}

/** Sort key for the group list: client first, then global, then envs, then config dirs. */
function groupRank(key: string): number {
  if (key === SYNTHETIC_GROUP_KEY) return 0;
  if (key === "global") return 1;
  return key.startsWith("env:") ? 2 : 3;
}

/**
 * Rows bucketed by scope and by what the operator can do about them. `labelFor` is injected so this
 * module never imports `EnvState` — and so the caller can keep the label source stable across the
 * board switch that empties `envs`.
 */
export function groupChecks(checks: readonly Check[], labelFor: (envId: string) => string): CheckGroup[] {
  const byKey = new Map<string, { label: string; problems: Check[]; ok: Check[]; na: Check[]; pending: Check[] }>();
  for (const c of checks) {
    const key = groupKeyOf(c);
    let g = byKey.get(key);
    if (g === undefined) {
      g = { label: groupLabelOf(c, labelFor), problems: [], ok: [], na: [], pending: [] };
      byKey.set(key, g);
    }
    if (c.state === "problem") g.problems.push(c);
    else if (c.state === "pending") g.pending.push(c);
    else if (c.state === "n/a") g.na.push(c);
    else g.ok.push(c);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => groupRank(a) - groupRank(b) || a.localeCompare(b))
    .map(([key, g]) => ({
      key, label: g.label,
      // Severity ranks ONLY inside `problems` — every other bucket has a severity the schema calls meaningless.
      problems: [...g.problems].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
      ok: g.ok, na: g.na, pending: g.pending,
    }));
}
