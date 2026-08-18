import type { Check } from "@shared/diagnostics-schema";
import { checkKey } from "@shared/diagnostics-schema";
import { z } from "zod";

import type { CheckDeps } from "./deps.ts";
import { resolveCommandPath } from "./deps.ts";

const HookEntrySchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(z.object({ type: z.string(), command: z.string() })).default([]),
});

/**
 * `settings.json` belongs to Claude Code, not corral, so this schema validates only the parts
 * corral reads. Every field is `.optional()` and unknown keys are ignored (zod's default) — an
 * unrelated hook entry, a theme string, or any future Claude Code field must never invalidate the
 * parse and make `statusline-registered` report a problem on a config whose statusline is
 * registered correctly.
 */
export const SettingsSchema = z.object({
  statusLine: z.object({ type: z.string(), command: z.string() }).optional(),
  theme: z.string().optional(),
  hooks: z.record(z.string(), z.array(HookEntrySchema)).optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * A discriminated result, not a bare `Settings | null`: `statusline-registered` must report an
 * absent settings.json and a malformed one distinctly (two different operator fixes), which a
 * single `null` cannot express. Tasks 7 and 8 read the same file through this result rather than
 * re-parsing `settings.json` their own way.
 */
export type SettingsResult =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "ok"; readonly settings: Settings };

/** Reads and validates `<dir>/settings.json`. Never throws — a parse failure is a result, not an exception. */
export function readSettings(deps: CheckDeps, dir: string): SettingsResult {
  const text = deps.readText(`${dir}/settings.json`);
  if (text === null) return { kind: "absent" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  const parsed = SettingsSchema.safeParse(json);
  if (!parsed.success) return { kind: "malformed" };
  return { kind: "ok", settings: parsed.data };
}

const CAPTURE_SCRIPT = "corral-status-capture.sh";

/**
 * The helper file installed per config dir (README → "Installing the helper files"): present and
 * executable, or the statusline capture pipeline has nothing to run.
 */
function captureScriptCheck(deps: CheckDeps, envId: string, dir: string, now: number): Check {
  const scope = { kind: "configDir" as const, envId, dir };
  const base = {
    id: "capture-script", key: checkKey("capture-script", scope), scope,
    doc: { anchor: "installing-the-claude-helper-files-per-config-dir", title: "Installing the helper files" },
    class: "cheap" as const, checkedAt: now, startupOkLine: false, haltsStartup: false,
  };
  const scriptPath = `${dir}/${CAPTURE_SCRIPT}`;
  if (!deps.isFile(scriptPath)) {
    return {
      ...base, title: `${CAPTURE_SCRIPT} is missing in ${dir}`,
      state: "problem", severity: "warning",
      detail: `Expected ${scriptPath}. Copy it from scripts/${CAPTURE_SCRIPT} and chmod +x it.`,
    };
  }
  if (!deps.isExec(scriptPath)) {
    return {
      ...base, title: `${CAPTURE_SCRIPT} is present but not executable in ${dir}`,
      state: "problem", severity: "warning",
      detail: `${scriptPath} exists but is not executable — chmod +x it.`,
    };
  }
  return {
    ...base, title: `${CAPTURE_SCRIPT} is installed and executable in ${dir}`,
    state: "ok", severity: "warning", detail: "",
  };
}

/**
 * Whether Claude Code's `statusLine` is wired to corral's capture pipeline for this config dir.
 *
 * Tests the INJECT LINE, never the filename: `statusLine.command` is resolved through
 * `resolveCommandPath` and the referenced file's TEXT must contain `corral-status-capture.sh`.
 * Matching on the filename `statusline-command.sh` would pass a drifted copy of corral's own
 * script that no longer contains the inject — the exact failure the `helper-drift` check exists
 * to catch, waved through by the check next to it. Reading the referenced file's content instead
 * covers an operator's own script too (README explicitly allows a custom command), so one rule
 * serves both.
 */
function statuslineRegisteredCheck(deps: CheckDeps, envId: string, dir: string, now: number): Check {
  const scope = { kind: "configDir" as const, envId, dir };
  const base = {
    id: "statusline-registered", key: checkKey("statusline-registered", scope), scope,
    doc: { anchor: "claude-statusline-live-metrics", title: "Claude statusline" },
    class: "cheap" as const, checkedAt: now, startupOkLine: false, haltsStartup: false,
  };
  const result = readSettings(deps, dir);
  if (result.kind === "absent") {
    return {
      ...base, title: `no settings.json in ${dir}`,
      state: "problem", severity: "warning",
      detail: `Expected ${dir}/settings.json to register a statusLine command that invokes ${CAPTURE_SCRIPT}.`,
    };
  }
  if (result.kind === "malformed") {
    return {
      ...base, title: `settings.json in ${dir} could not be parsed`,
      state: "problem", severity: "warning",
      detail: `${dir}/settings.json is not valid JSON, so the statusLine registration could not be read.`,
    };
  }
  const statusLine = result.settings.statusLine;
  if (statusLine?.type !== "command") {
    return {
      ...base, title: `no statusline command registered in ${dir}`,
      state: "problem", severity: "warning",
      detail: `${dir}/settings.json must set statusLine.type to "command" and statusLine.command to a script that invokes ${CAPTURE_SCRIPT}.`,
    };
  }
  const scriptPath = resolveCommandPath(statusLine.command, deps.env.HOME);
  const text = deps.readText(scriptPath);
  if (text === null) {
    return {
      ...base, title: `statusline command not readable in ${dir}`,
      state: "problem", severity: "warning",
      detail: `Could not read ${scriptPath} — the script referenced by statusLine.command in ${dir}/settings.json.`,
    };
  }
  if (!text.includes(CAPTURE_SCRIPT)) {
    return {
      ...base, title: `statusline command does not invoke ${CAPTURE_SCRIPT} in ${dir}`,
      state: "problem", severity: "warning",
      detail: `${scriptPath} does not reference ${CAPTURE_SCRIPT} — the statusline will not feed corral's live metrics.`,
    };
  }
  return {
    ...base, title: `statusline registered and wired to ${CAPTURE_SCRIPT} in ${dir}`,
    state: "ok", severity: "warning", detail: "",
  };
}

/**
 * Two per-config-dir checks: `capture-script` and `statusline-registered`. Deps-only — no
 * `env.kind` branch needed: called directly for local dirs, and for remote dirs via the remote
 * adapter, which runs these same producers over a recording facade fed by SSH-probed facts.
 */
export function metricsChecks(deps: CheckDeps, envId: string, dir: string): Check[] {
  const now = deps.now();
  return [
    captureScriptCheck(deps, envId, dir, now),
    statuslineRegisteredCheck(deps, envId, dir, now),
  ];
}
