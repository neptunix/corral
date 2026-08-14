import type { Check } from "@shared/diagnostics-schema";
import { checkKey } from "@shared/diagnostics-schema";
import type { SessionRow } from "@shared/schema";

import { NODE_MIN } from "./constants.ts";
import { locateTool } from "./deps.ts";
import type { CheckDeps } from "./deps.ts";
import { configDirsChecks } from "./startup.ts";
import type { HerdrEnv } from "../../environments.ts";

/**
 * Numeric semver compare, not lexical: "0.6.10" must sort above "0.6.9". A leading "v" is stripped,
 * a prerelease suffix ("-rc.1") is dropped entirely rather than compared, and a short form ("1.0")
 * pads its missing components with 0 — the same leniency every version string in this file's checks
 * needs (herdr/Claude/Node all appear both bare and prefixed in the wild).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parts = (v: string): number[] => {
    const stripped = v.trim().replace(/^v/, "").split("-")[0] ?? "";
    return stripped.split(".").map((n) => Number.parseInt(n, 10) || 0);
  };
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

const GLOBAL_SCOPE = { kind: "global" as const };

/** Node's own runtime version against the floor this server requires (`NODE_MIN`, constants.ts). */
export function nodeVersionCheck(deps: CheckDeps): Check {
  const below = compareSemver(deps.nodeVersion, NODE_MIN) < 0;
  return {
    id: "node-version", key: checkKey("node-version", GLOBAL_SCOPE), scope: GLOBAL_SCOPE,
    title: below
      ? `Node ${deps.nodeVersion} is below the required ${NODE_MIN}`
      : `Node ${deps.nodeVersion} meets the required ${NODE_MIN}`,
    state: below ? "problem" : "ok",
    severity: "warning",
    detail: below
      ? `corral requires Node >= ${NODE_MIN}; this server is running ${deps.nodeVersion}.`
      : "",
    doc: { anchor: "quick-start", title: "Quick start" },
    class: "cheap", checkedAt: deps.now(), startupOkLine: false, haltsStartup: false,
  };
}

const JQ_DETAIL =
  "without jq the metrics capture pipeline cannot parse Claude Code's hook JSON, so the " +
  "statusline never writes a status file and the context-pressure protocol has nothing to read.";

/** `jq` resolvability for one LOCAL environment; a remote environment's jq lives on the far host. */
function jqPresentCheck(deps: CheckDeps, env: HerdrEnv, now: number): Check {
  const scope = { kind: "env" as const, envId: env.id };
  const base = {
    id: "jq-present", key: checkKey("jq-present", scope), scope,
    doc: { anchor: "quick-start", title: "Quick start" },
    class: "cheap" as const, checkedAt: now, startupOkLine: false, haltsStartup: false,
  };
  if (env.kind === "remote") {
    return { ...base, title: `jq: environment "${env.id}" is remote — checked by the far host`, state: "pending", severity: "fatal", detail: "" };
  }
  const located = locateTool("jq", deps);
  if (located.path === null) {
    return {
      ...base, title: `jq is not installed for environment "${env.id}"`,
      state: "problem", severity: "fatal", detail: JQ_DETAIL,
    };
  }
  return {
    ...base,
    title: located.onServerPath
      ? `jq resolved on PATH for environment "${env.id}"`
      : `jq found for environment "${env.id}", but outside this server's PATH`,
    state: "ok", severity: "fatal",
    detail: located.onServerPath ? "" : `Found at ${located.path}.`,
  };
}

/** One `config-dir-exists` row per configured dir of a LOCAL environment; remote dirs are `pending`. */
function configDirExistsChecks(deps: CheckDeps, env: HerdrEnv, now: number): Check[] {
  return env.claudeConfigDirs.map((dir) => {
    const scope = { kind: "configDir" as const, envId: env.id, dir };
    const base = {
      id: "config-dir-exists", key: checkKey("config-dir-exists", scope), scope,
      doc: { anchor: "environments", title: "Environments" },
      class: "cheap" as const, checkedAt: now, startupOkLine: false, haltsStartup: false,
    };
    if (env.kind === "remote") {
      return { ...base, title: `${dir}: on a remote host — not checked here`, state: "pending" as const, severity: "warning" as const, detail: "" };
    }
    if (deps.isDir(dir)) {
      return { ...base, title: `${dir} exists`, state: "ok" as const, severity: "warning" as const, detail: "" };
    }
    return {
      ...base, title: `${dir} does not exist`, state: "problem" as const, severity: "warning" as const,
      detail: `Configured as a claudeConfigDirs entry for environment "${env.id}" but not found on disk — check for a typo.`,
    };
  });
}

const STATUS_READABLE_DETAIL =
  "the statusline never wrote a readable status file, so live metrics and the context-pressure " +
  "protocol have nothing to read for this environment.";

/** Real metrics failures — data was expected and did not arrive readable — count as `problem`. */
function isStatuslineFailure(status: SessionRow["statuslineStatus"]): boolean {
  switch (status) {
    case "not-found":
    case "bad-schema":
    case "read-error":
      return true;
    case "ok":
    case "no-session-ref":
    case null:
      return false;
  }
}

/**
 * Whether the poller has actually seen readable status data for this environment's LIVE sessions.
 * There is no session-to-config-dir mapping in corral, so this reads `SessionRow.statuslineStatus` —
 * the poller's own verdict per session — rather than the disk. `n/a` with no live sessions (nothing
 * should be writing); `no-session-ref`/`null` stay `pending` (nothing SHOULD have been written yet);
 * any real read failure among live sessions is a `problem` once no session on the env reports `ok`.
 */
function statusReadableCheck(env: HerdrEnv, sessions: readonly SessionRow[], now: number): Check {
  const scope = { kind: "env" as const, envId: env.id };
  const base = {
    id: "status-readable", key: checkKey("status-readable", scope), scope,
    doc: { anchor: "claude-statusline-live-metrics", title: "Claude statusline" },
    class: "cheap" as const, checkedAt: now, startupOkLine: false, haltsStartup: false,
  };
  const onEnv = sessions.filter((s) => s.env === env.id);
  if (onEnv.length === 0) {
    return {
      ...base, title: `no live sessions on environment "${env.id}"`,
      state: "n/a", severity: "warning", detail: "no live session on this environment to read a status from.",
    };
  }
  if (onEnv.some((s) => s.statuslineStatus === "ok")) {
    return { ...base, title: `statusline readable on environment "${env.id}"`, state: "ok", severity: "warning", detail: "" };
  }
  if (onEnv.some((s) => isStatuslineFailure(s.statuslineStatus))) {
    return {
      ...base, title: `statusline not readable on environment "${env.id}"`,
      state: "problem", severity: "warning", detail: STATUS_READABLE_DETAIL,
    };
  }
  return {
    ...base, title: `statusline not yet reported on environment "${env.id}"`,
    state: "pending", severity: "warning", detail: "",
  };
}

/**
 * Per-environment checks: `jq-present`, `config-dir-exists` (per configured dir), `status-readable`,
 * plus `claude-config-dirs` — produced by `configDirsChecks` (server/diagnostics/startup.ts), the
 * startup report's existing single producer for that subject; this file must not grow a second one.
 * `node-version` is global and deliberately not folded in here — it is composed alongside this
 * function's output by the caller that builds the full check set.
 */
export function envChecks(
  deps: CheckDeps, envs: readonly HerdrEnv[], sessions: readonly SessionRow[],
): Check[] {
  const now = deps.now();
  const checks: Check[] = [...configDirsChecks(envs, now)];
  for (const env of envs) {
    checks.push(jqPresentCheck(deps, env, now));
    checks.push(...configDirExistsChecks(deps, env, now));
    checks.push(statusReadableCheck(env, sessions, now));
  }
  return checks;
}
