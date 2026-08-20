import type { SpawnPreset } from "@shared/board-schema";
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
 * `scope` and `class` are forced to existing enum members because a view-only concern must not widen
 * either enum; the grouper lifts these two ids out by id, not by scope.
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

/** The ad-hoc task title and the ephemeral spawn preset the "Fix issues" button seeds — never persisted
 *  to `board.spawnPresets`, only handed to `useSpawnForm` for one modal instance. */
export const FIX_ISSUES_PRESET_ID = "corral-doctor-fix";
// Headroom under the server's 2000-char cap on `startCommand` (POST spawn), so composeFixBrief's own
// truncation never lands exactly on that boundary and clips mid-line.
const FIX_ISSUES_CHAR_CAP = 1900;
const FIX_ISSUES_MAX_ROWS = 12;

// A remote-probe check's detail can carry raw ssh stderr and run to thousands of characters on its
// own — unbounded per shared/diagnostics-schema.ts. Capped and flattened here so one row can never eat
// the whole brief, and a literal newline in it can never break the one-row-per-line format the skill's
// own loop reads.
const FIX_ISSUES_DETAIL_CAP = 200;

function fixLine(c: Check, labelFor: (envId: string) => string): string {
  const where = c.scope.kind === "global" ? null
    : c.scope.kind === "env" ? labelFor(c.scope.envId)
    : `${labelFor(c.scope.envId)} · ${c.scope.dir}`;
  const prefix = where === null ? "" : `[${where}] `;
  const flatDetail = c.detail.replace(/\s+/g, " ").trim();
  const clippedDetail = flatDetail.length > FIX_ISSUES_DETAIL_CAP
    ? `${flatDetail.slice(0, FIX_ISSUES_DETAIL_CAP - 1)}…` : flatDetail;
  const detail = clippedDetail === "" ? "" : ` — ${clippedDetail}`;
  const doc = c.doc === null ? "" : ` (README: ${c.doc.title})`;
  return `- ${prefix}[${c.severity}] ${c.title}${detail}${doc}`;
}

function fixIssuesTitle(problemCount: number): string {
  return problemCount === 1 ? "Fix 1 corral issue" : `Fix ${String(problemCount)} corral issues`;
}

/**
 * `/corral-doctor` at position 0 is what makes this a skill invocation rather than plain text — the
 * skill (installed alongside `corral`'s own) reads the listed checks, applies the fix each `doc`
 * points at, and rechecks. Synthetic rows (`backend-unreachable`, `sweep-failed`) are excluded by the
 * caller: neither names an install defect a spawned session could fix.
 *
 * The fallback line matters: an operator who never installed `skills/corral-doctor` gets a spawned
 * session that greets `/corral-doctor` with "Unknown command" and stops there with nothing else to go
 * on. Naming the file directly gives it a path to the same instructions without the skill.
 */
// Generous headroom for the "… N more" tail, reserved BEFORE rows are added rather than sliced off
// the end afterward — a blind end-slice could cut a row in half AND drop the one line that says rows
// were cut, which is what the old version did.
const FIX_ISSUES_TAIL_MARGIN = 60;

export function composeFixBrief(problems: readonly Check[], labelFor: (envId: string) => string): string {
  const sorted = [...problems].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const intro = `/corral-doctor fix\n\n${String(sorted.length)} corral diagnostics `
    + `${sorted.length === 1 ? "problem needs" : "problems need"} fixing. Use the corral-doctor skill `
    + "(if that command was not recognized, read skills/corral-doctor/SKILL.md in this repo instead): "
    + "for each row below, read the README section it names, apply the fix, then recheck "
    + "(POST /api/diagnostics/refresh, or Recheck in the Health panel) before moving on.\n\n";
  const budget = FIX_ISSUES_CHAR_CAP - intro.length - FIX_ISSUES_TAIL_MARGIN;
  const lines: string[] = [];
  let used = 0;
  for (const c of sorted) {
    if (lines.length >= FIX_ISSUES_MAX_ROWS) break;
    const line = fixLine(c, labelFor);
    const cost = line.length + (lines.length > 0 ? 1 : 0); // +1 for the joining newline
    // The first row always lands regardless of budget — an empty body (every row skipped because the
    // very first one alone exceeds what's left) is worse than one long row.
    if (lines.length > 0 && used + cost > budget) break;
    lines.push(line);
    used += cost;
  }
  const omitted = sorted.length - lines.length;
  const tail = omitted > 0 ? `\n… ${String(omitted)} more — open the Health panel for the rest.` : "";
  return `${intro}${lines.join("\n")}${tail}`;
}

/**
 * `null` when there is nothing a fixer session could act on — the button that calls this hides itself
 * on that result rather than opening a task with an empty brief.
 *
 * `description` is the SAME text as `preset.text`, not a separate summary of it: the preset is
 * ephemeral (cleared with the modal, never persisted — see TaskEditModal's extraPreset), so the
 * description is the only durable copy. A separate hand-written description drifts from what the
 * preset actually says and goes stale the moment the modal closes; a card with no session left behind
 * still carries the real fix instructions this way, readable by a human or a session that resumes it.
 */
export function buildFixPreset(
  checks: readonly Check[],
  labelFor: (envId: string) => string,
): { readonly title: string; readonly description: string; readonly preset: SpawnPreset } | null {
  const problems = checks.filter((c) => c.state === "problem" && !SYNTHETIC_IDS.has(c.id));
  if (problems.length === 0) return null;
  const brief = composeFixBrief(problems, labelFor);
  return {
    title: fixIssuesTitle(problems.length),
    description: brief,
    preset: { id: FIX_ISSUES_PRESET_ID, text: brief },
  };
}
