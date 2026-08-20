import type { Check, CheckScope } from "@shared/diagnostics-schema";
import { checkKey } from "@shared/diagnostics-schema";
import type { EnvState } from "@shared/schema";

const ENV_DOC = { anchor: "environments", title: "Environments" };

/**
 * Checks whose id names something that literally cannot run once herdr is unreachable — a version
 * probe or an integration-status read both shell out through herdr itself. Every other check that
 * merely SCOPES to the same env (reading settings.json, stat'ing a script, hashing a file) still
 * runs: suppressing those on the strength of an unrelated socket outage would hide a real install
 * problem behind it, which is the silent-degradation failure this feature exists to kill, inverted.
 * `remote`-class checks are never suppressed here either (R16) — their own probed outcome is their
 * truth, not a herdr-reachability inference.
 */
export const NEEDS_HERDR: ReadonlySet<string> = new Set(["herdr-version", "herdr-claude-integration"]);

/**
 * One `env-reachable` row per environment the poller has an opinion about. No probe of its own:
 * `poller.ts` already records `{ reachable, error }` per env on every sweep, this just renders it.
 * An env absent from `envs` (the poller has not answered for it yet) produces no row at all.
 */
export function envReachableChecks(envs: Readonly<Record<string, EnvState>>, now: number): Check[] {
  const checks: Check[] = [];
  for (const [envId, state] of Object.entries(envs)) {
    const scope: CheckScope = { kind: "env", envId };
    const name = state.label ?? envId;
    checks.push({
      id: "env-reachable", key: checkKey("env-reachable", scope), scope,
      title: state.reachable ? `${name} is reachable` : `${name} is not reachable`,
      state: state.reachable ? "ok" : "problem",
      severity: "warning",
      detail: state.reachable ? "" : (state.error ?? ""),
      doc: ENV_DOC,
      class: "cheap", checkedAt: now, startupOkLine: false, haltsStartup: false,
    });
  }
  return checks;
}

/** Whether `c` needs an unreachable env's herdr to run at all, per `NEEDS_HERDR`. */
function needsUnreachableHerdr(c: Check, unreachableEnvIds: ReadonlySet<string>): boolean {
  if (c.id === "env-reachable") return false;
  if (c.scope.kind === "global") return false;
  if (!unreachableEnvIds.has(c.scope.envId)) return false;
  return NEEDS_HERDR.has(c.id);
}

/**
 * Collapses every check that cannot run because its environment's herdr is unreachable into one
 * `n/a` row per env, counted in the title. Checks that merely scope to that env but do not NEED
 * herdr (filesystem reads, hashing, etc.) pass through untouched — see `NEEDS_HERDR`'s comment.
 * With no unreachable envs, `checks` is returned as-is.
 */
export function suppressUnrunnable(
  checks: readonly Check[], unreachableEnvIds: ReadonlySet<string>, now: number,
): Check[] {
  if (unreachableEnvIds.size === 0) return [...checks];

  const kept: Check[] = [];
  const suppressedCountByEnv = new Map<string, number>();
  for (const c of checks) {
    if (c.scope.kind !== "global" && needsUnreachableHerdr(c, unreachableEnvIds)) {
      const envId = c.scope.envId;
      suppressedCountByEnv.set(envId, (suppressedCountByEnv.get(envId) ?? 0) + 1);
      continue;
    }
    kept.push(c);
  }

  for (const [envId, count] of suppressedCountByEnv) {
    const scope: CheckScope = { kind: "env", envId };
    kept.push({
      id: "env-unrunnable", key: checkKey("env-unrunnable", scope), scope,
      title: `${String(count)} check${count === 1 ? "" : "s"} skipped — environment "${envId}" is unreachable`,
      state: "n/a",
      severity: "warning",
      detail: "",
      doc: null,
      class: "cheap", checkedAt: now, startupOkLine: false, haltsStartup: false,
    });
  }

  return kept;
}
