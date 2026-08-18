import type { Check, CheckScope } from "@shared/diagnostics-schema";
import { checkKey } from "@shared/diagnostics-schema";

import { CLAUDE_VERIFIED, HERDR_MIN } from "./constants.ts";
import { compareSemver } from "./env.ts";
import type { HerdrEnv } from "../../environments.ts";
import type { RunTool } from "../exec-tool.ts";

export interface VersionCheckOpts {
  /**
   * Every configured environment. `versionChecks` itself skips `remote` ones and emits `pending`
   * rows for them — enforced HERE, not left to the caller: `herdr integration status` resolves
   * `CLAUDE_CONFIG_DIR` on the machine it runs on, so running it locally for a remote env's dirs
   * publishes a verdict about the wrong disk.
   */
  readonly envs: readonly HerdrEnv[];
  readonly run: RunTool;
  readonly ccVersionByEnv: Readonly<Record<string, string | null>>;
  readonly now: () => number;
}

const QUICK_START_DOC = { anchor: "quick-start", title: "Quick start" };
const INTEGRATION_DOC = { anchor: "herdrs-claude-integration", title: "herdr's Claude integration" };

const INTEGRATION_DETAIL =
  "without herdr's Claude integration installed and current, the attention feed never fires — " +
  "corral detects blocked/finished sessions from herdr's own agent status, and that status " +
  "depends on this integration.";

const REMOTE_NOTE = (envId: string): string =>
  `environment "${envId}" is remote — its herdr/Claude versions live on the far host and are not checked from here.`;

export interface IntegrationStatus {
  readonly installed: boolean;
  readonly current: boolean;
  readonly version: string | null;
}

const CLAUDE_LINE = /^claude:\s*(current|outdated|not installed)(?:\s*\(v(\d+)\))?/;

/**
 * Reads the `claude:` line out of `herdr integration status`'s flat text output. Returns null —
 * never a verdict — when no such line is found: unparseable output is not evidence of "not
 * installed", it is evidence the format changed or the command failed in an unexpected way.
 */
export function parseIntegrationStatus(text: string): IntegrationStatus | null {
  for (const line of text.split("\n")) {
    const match = CLAUDE_LINE.exec(line.trim());
    if (match === null) continue;
    const status = match[1];
    if (status === undefined) continue;
    if (status === "not installed") return { installed: false, current: false, version: null };
    return { installed: true, current: status === "current", version: match[2] ?? null };
  }
  return null;
}

const VERSION_NUMBER = /(\d+(?:\.\d+){1,3})/;

/** Pulls the first dotted version number out of a tool's `--version` banner, or null if there is none. */
function extractVersion(text: string): string | null {
  const match = VERSION_NUMBER.exec(text);
  return match?.[1] ?? null;
}

/**
 * `herdr --version` against `HERDR_MIN`. Only the floor is a verdict — there is deliberately no
 * upper "verified ceiling": the current release is already past it, so every operator on a
 * current herdr would carry a permanent `info` row that only a source edit clears.
 */
async function herdrVersionCheck(opts: VersionCheckOpts, env: HerdrEnv, now: number): Promise<Check> {
  const scope: CheckScope = { kind: "env", envId: env.id };
  const base = {
    id: "herdr-version", key: checkKey("herdr-version", scope), scope,
    doc: QUICK_START_DOC, class: "versions" as const, checkedAt: now,
    startupOkLine: false, haltsStartup: false, severity: "warning" as const,
  };
  const output = await opts.run("herdr", ["--version"]);
  if (output === null) {
    return {
      ...base, title: `herdr --version could not be run for environment "${env.id}"`,
      state: "n/a", detail: "",
    };
  }
  const version = extractVersion(output);
  if (version === null) {
    return {
      ...base, title: `herdr --version output could not be read for environment "${env.id}"`,
      state: "problem",
      detail:
        "the command ran but its output carried no recognizable version number — either herdr " +
        "changed its output format or the command failed in an unexpected way.",
    };
  }
  const below = compareSemver(version, HERDR_MIN) < 0;
  return {
    ...base,
    title: below
      ? `herdr ${version} is below the required ${HERDR_MIN}`
      : `herdr ${version} meets the required ${HERDR_MIN}`,
    state: below ? "problem" : "ok",
    detail: below
      ? `corral requires herdr >= ${HERDR_MIN} for environment "${env.id}"; found ${version}.`
      : "",
  };
}

/**
 * The local Claude CLI's own `--version` output, preferred over `opts.ccVersionByEnv[envId]` (the
 * version the statusline last reported). Neither answering is `n/a`, not a verdict about anything.
 *
 * `CLAUDE_VERIFIED` is a FLOOR here too, and for the same reason as herdr: corral's `--name` /
 * `--model` / `--remote-control` launch flags are verified against that build, not against a
 * ceiling, so a newer Claude Code is not a problem — this row stays `severity: "info"` even when
 * it fires, because it is a recommendation, not a failure.
 */
async function claudeCliVersionCheck(opts: VersionCheckOpts, env: HerdrEnv, now: number): Promise<Check> {
  const scope: CheckScope = { kind: "env", envId: env.id };
  const base = {
    id: "claude-cli-version", key: checkKey("claude-cli-version", scope), scope,
    doc: QUICK_START_DOC, class: "versions" as const, checkedAt: now,
    startupOkLine: false, haltsStartup: false, severity: "info" as const,
  };
  const localOutput = await opts.run("claude", ["--version"]);
  const localVersion = localOutput === null ? null : extractVersion(localOutput);
  const fallback = opts.ccVersionByEnv[env.id] ?? null;
  const version = localVersion ?? fallback;
  const fromStatusline = localVersion === null && fallback !== null;
  if (version === null) {
    return {
      ...base, title: `Claude CLI version unknown for environment "${env.id}"`,
      state: "n/a",
      detail: "neither `claude --version` nor the statusline reported a version for this environment.",
    };
  }
  const source = fromStatusline ? " (from the statusline)" : "";
  const below = compareSemver(version, CLAUDE_VERIFIED) < 0;
  return {
    ...base,
    title: below
      ? `Claude CLI ${version}${source} is older than the verified build ${CLAUDE_VERIFIED}`
      : `Claude CLI ${version}${source} meets or exceeds the verified build ${CLAUDE_VERIFIED}`,
    state: below ? "problem" : "ok",
    detail: below
      ? `corral's --name/--model/--remote-control launch flags were verified against Claude Code ` +
        `${CLAUDE_VERIFIED}; environment "${env.id}" reports ${version}${source}. Newer is fine — ` +
        `this is informational, not a failure.`
      : "",
  };
}

/** One `herdr-claude-integration` row for the given scope, running `herdr integration status` with `extraEnv`. */
async function integrationCheckAt(
  opts: VersionCheckOpts, env: HerdrEnv, scope: CheckScope, extraEnv: Readonly<Record<string, string>> | undefined, now: number,
): Promise<Check> {
  const base = {
    id: "herdr-claude-integration", key: checkKey("herdr-claude-integration", scope), scope,
    doc: INTEGRATION_DOC, class: "versions" as const, checkedAt: now,
    startupOkLine: false, haltsStartup: false, severity: "warning" as const,
  };
  const runOpts = extraEnv === undefined ? undefined : { extraEnv };
  const output = await opts.run("herdr", ["integration", "status"], runOpts);
  if (output === null) {
    return {
      ...base, title: `herdr integration status could not be run for environment "${env.id}"`,
      state: "n/a", detail: "",
    };
  }
  const parsed = parseIntegrationStatus(output);
  if (parsed === null) {
    return {
      ...base, title: `herdr's Claude integration status output could not be read for environment "${env.id}"`,
      state: "problem",
      detail:
        "the command ran but no `claude:` line could be parsed from its output — either herdr " +
        "changed its output format or the command failed in an unexpected way.",
    };
  }
  if (parsed.installed && parsed.current) {
    return {
      ...base, title: `herdr's Claude integration is installed and current for environment "${env.id}"`,
      state: "ok", detail: "",
    };
  }
  const reason = parsed.installed ? `outdated (v${parsed.version ?? "?"})` : "not installed";
  return {
    ...base, title: `herdr's Claude integration is ${reason} for environment "${env.id}"`,
    state: "problem", detail: INTEGRATION_DETAIL,
  };
}

/**
 * One `herdr-claude-integration` row per configured config dir, scoped `configDir`; with an empty
 * `claudeConfigDirs`, one row scoped `env` instead.
 */
function integrationChecks(opts: VersionCheckOpts, env: HerdrEnv, now: number): Promise<Check[]> {
  if (env.claudeConfigDirs.length === 0) {
    const scope: CheckScope = { kind: "env", envId: env.id };
    return integrationCheckAt(opts, env, scope, undefined, now).then((c) => [c]);
  }
  return Promise.all(env.claudeConfigDirs.map((dir) => {
    const scope: CheckScope = { kind: "configDir", envId: env.id, dir };
    return integrationCheckAt(opts, env, scope, { CLAUDE_CONFIG_DIR: dir }, now);
  }));
}

/**
 * The three rows for one LOCAL environment, run concurrently: `herdr --version`, `claude
 * --version`, and one `herdr integration status` probe per config dir.
 */
async function localEnvChecks(opts: VersionCheckOpts, env: HerdrEnv, now: number): Promise<Check[]> {
  const [herdrVersion, claudeCli, integration] = await Promise.all([
    herdrVersionCheck(opts, env, now),
    claudeCliVersionCheck(opts, env, now),
    integrationChecks(opts, env, now),
  ]);
  return [herdrVersion, claudeCli, ...integration];
}

/**
 * `pending` rows for a REMOTE environment, standing in for all three subjects with NO probe run:
 * `herdr integration status` resolves `CLAUDE_CONFIG_DIR` on the machine it runs on, so running it
 * locally for a remote env's dirs would publish a verdict about the wrong disk.
 */
function remoteEnvChecks(env: HerdrEnv, now: number): Check[] {
  const note = REMOTE_NOTE(env.id);
  const envScope: CheckScope = { kind: "env", envId: env.id };
  const herdrVersionRow: Check = {
    id: "herdr-version", key: checkKey("herdr-version", envScope), scope: envScope,
    title: `herdr version not checked for remote environment "${env.id}"`,
    state: "pending", severity: "warning", detail: note,
    doc: QUICK_START_DOC, class: "versions", checkedAt: now, startupOkLine: false, haltsStartup: false,
  };
  const claudeCliRow: Check = {
    id: "claude-cli-version", key: checkKey("claude-cli-version", envScope), scope: envScope,
    title: `Claude CLI version not checked for remote environment "${env.id}"`,
    state: "pending", severity: "info", detail: note,
    doc: QUICK_START_DOC, class: "versions", checkedAt: now, startupOkLine: false, haltsStartup: false,
  };
  const dirScopes: readonly CheckScope[] = env.claudeConfigDirs.length === 0
    ? [envScope]
    : env.claudeConfigDirs.map((dir): CheckScope => ({ kind: "configDir", envId: env.id, dir }));
  const integrationRows: Check[] = dirScopes.map((scope) => ({
    id: "herdr-claude-integration", key: checkKey("herdr-claude-integration", scope), scope,
    title: `herdr's Claude integration not checked for remote environment "${env.id}"`,
    state: "pending", severity: "warning", detail: note,
    doc: INTEGRATION_DOC, class: "versions", checkedAt: now, startupOkLine: false, haltsStartup: false,
  }));
  return [herdrVersionRow, claudeCliRow, ...integrationRows];
}

/**
 * `herdr-version`, `herdr-claude-integration` (one per config dir), and `claude-cli-version` for
 * every configured environment, all filed under `class: "versions"` so the `cheap` sweep never
 * clears them. Probes run concurrently with `Promise.all`, both across environments and within one.
 *
 * Skips `remote` environments itself (see `remoteEnvChecks`) rather than leaving that to the
 * caller — no probe here ever runs for one.
 */
export async function versionChecks(opts: VersionCheckOpts): Promise<Check[]> {
  const now = opts.now();
  const perEnv = await Promise.all(opts.envs.map((env) =>
    env.kind === "remote" ? Promise.resolve(remoteEnvChecks(env, now)) : localEnvChecks(opts, env, now),
  ));
  return perEnv.flat();
}
