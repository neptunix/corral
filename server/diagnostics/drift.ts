import type { Check } from "@shared/diagnostics-schema";
import { checkKey } from "@shared/diagnostics-schema";

import type { CheckDeps } from "./deps.ts";
import { readSettings } from "./metrics.ts";

const DRIFT_DOC = { anchor: "upgrading", title: "Upgrading" };
const THEME_DOC = { anchor: "claude-theme-optional", title: "Claude theme" };
const THEME_SELECTION = "custom:corral";

/**
 * Corral's own protocol implementations installed per config dir, paired with their repo-side
 * source (README → "Installing the Claude helper files"): `[installed name, repo-relative path]`.
 * Deliberately excludes `statusline-command.sh` — README's arrangement lets an operator keep their
 * own script there with one inject line, so drift on that file is normal and expected; that is
 * exactly why `statusline-registered` (metrics.ts) tests the inject rather than file identity.
 */
export const DRIFT_FILES: readonly (readonly [installed: string, repo: string])[] = [
  ["corral-status-capture.sh", "scripts/corral-status-capture.sh"],
  ["corral-claude-hook.sh", "scripts/corral-claude-hook.sh"],
  ["skills/corral/SKILL.md", "skills/corral/SKILL.md"],
] as const;

/**
 * The installed copy of a tracked file, compared by content hash against the checkout's own copy.
 * A file that is not installed is skipped entirely — its absence is reported by that file's own
 * check (`ctx-hook-installed`, `corral-skill-installed`, `capture-script`), not here.
 */
interface DriftResult {
  readonly name: string;
  /** null when the repo-side copy could not be hashed — no baseline to compare against. */
  readonly repoHash: string | null;
  /** null when the file is not installed — nothing to compare. */
  readonly installedHash: string | null;
}

function driftResults(deps: CheckDeps, dir: string): DriftResult[] {
  return DRIFT_FILES.map(([installed, repo]) => ({
    name: installed,
    repoHash: deps.hashFile(`${deps.repoRoot}/${repo}`),
    installedHash: deps.hashFile(`${dir}/${installed}`),
  }));
}

/**
 * One check for the whole tracked group, not one per file: three green rows saying "matches" is
 * noise, so a single row names the drifted files in its detail when something is stale.
 *
 * `hashFile` follows symlinks, so a symlink into the checkout (README's recommended arrangement
 * for `corral-claude-hook.sh`) hashes equal to its source and is never reported as drift.
 *
 * `n/a` when NO repo-side hash could be computed at all — with no baseline whatsoever, reporting
 * drift would be a guess, not a finding.
 */
export function driftCheck(deps: CheckDeps, envId: string, dir: string): Check {
  const scope = { kind: "configDir" as const, envId, dir };
  const base = {
    id: "helper-drift", key: checkKey("helper-drift", scope), scope, doc: DRIFT_DOC,
    class: "cheap" as const, checkedAt: deps.now(), startupOkLine: false, haltsStartup: false,
  };
  const results = driftResults(deps, dir);
  if (results.every((r) => r.repoHash === null)) {
    return {
      ...base, title: `helper drift not checked in ${dir}`,
      state: "n/a", severity: "warning",
      detail: `None of the tracked files could be hashed in this checkout (${deps.repoRoot}) — no baseline to compare ${dir} against.`,
    };
  }
  const installed = results.filter((r) => r.installedHash !== null);
  const drifted = installed.filter((r) => r.repoHash !== null && r.repoHash !== r.installedHash);
  if (drifted.length === 0) {
    return {
      ...base, title: `installed helper files match the checkout in ${dir}`,
      state: "ok", severity: "warning", detail: "",
    };
  }
  const names = drifted.map((r) => r.name).join(", ");
  return {
    ...base, title: `installed helper files differ from the checkout in ${dir}`,
    state: "problem", severity: "warning",
    detail: `${names} in ${dir} do not match this checkout — re-copy from the paths in README → "Installing the Claude helper files", or check whether this server is running an older checkout than the installed copies.`,
  };
}

/**
 * Whether the corral Claude-theme preset is installed AND selected (README → "Claude theme
 * (optional)"). Reuses `readSettings` rather than re-parsing `settings.json`: the preset file is a
 * plain filesystem fact, but the "is it selected" half must read the same validated shape
 * `statusline-registered`/`ctx-hook-registered` already read.
 *
 * The theme is entirely optional, so both failure modes are `info`, never `warning`.
 */
export function themeCheck(deps: CheckDeps, envId: string, dir: string): Check {
  const scope = { kind: "configDir" as const, envId, dir };
  const base = {
    id: "theme-installed", key: checkKey("theme-installed", scope), scope, doc: THEME_DOC,
    class: "cheap" as const, checkedAt: deps.now(), startupOkLine: false, haltsStartup: false,
  };
  const presetPath = `${dir}/themes/corral.json`;
  if (!deps.isFile(presetPath)) {
    return {
      ...base, title: `corral theme preset is not installed in ${dir}`,
      state: "problem", severity: "info",
      detail: `Expected ${presetPath}. Optional — copy it from themes/corral.json if you want the live light/dark toggle.`,
    };
  }
  const result = readSettings(deps, dir);
  const selected = result.kind === "ok" && result.settings.theme === THEME_SELECTION;
  if (!selected) {
    return {
      ...base, title: `corral theme preset installed but not selected in ${dir}`,
      state: "problem", severity: "info",
      detail: `${presetPath} exists but ${dir}/settings.json does not set "theme": "${THEME_SELECTION}" — run /theme and pick corral, or edit settings.json.`,
    };
  }
  return {
    ...base, title: `corral theme installed and selected in ${dir}`,
    state: "ok", severity: "info", detail: "",
  };
}
