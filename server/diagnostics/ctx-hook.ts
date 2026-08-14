import type { Check } from "@shared/diagnostics-schema";
import { checkKey } from "@shared/diagnostics-schema";
import { z } from "zod";

import type { CheckDeps } from "./deps.ts";
import { resolveCommandPath } from "./deps.ts";
import { readSettings } from "./metrics.ts";
import type { Settings } from "./metrics.ts";

const HOOK_SCRIPT = "corral-claude-hook.sh";
const DOC = { anchor: "claude-context-pressure-hook", title: "Context-pressure hook" };
const SIGNAL_START = "<!-- ctx-signal:start -->";
const SIGNAL_END = "<!-- ctx-signal:end -->";

/**
 * Every link of the context-pressure hook chain fails silently by design — `corral-claude-hook.sh`
 * runs `set -euo pipefail` with `trap 'exit 0' ERR` and exits 0 at seven separate preconditions
 * (README → "Claude context-pressure hook"). Each precondition therefore needs its own visible
 * check here; the hook itself will never tell an operator which one failed.
 */
function hookInstalledCheck(deps: CheckDeps, envId: string, dir: string, now: number): Check {
  const scope = { kind: "configDir" as const, envId, dir };
  const base = {
    id: "ctx-hook-installed", key: checkKey("ctx-hook-installed", scope), scope, doc: DOC,
    class: "cheap" as const, checkedAt: now, startupOkLine: false, haltsStartup: false,
  };
  const scriptPath = `${dir}/${HOOK_SCRIPT}`;
  if (!deps.isFile(scriptPath)) {
    return {
      ...base, title: `${HOOK_SCRIPT} is missing in ${dir}`,
      state: "problem", severity: "warning",
      detail: `Expected ${scriptPath}. Sessions never learn their own context percentage without it — copy it from scripts/${HOOK_SCRIPT} and chmod +x it.`,
    };
  }
  if (!deps.isExec(scriptPath)) {
    return {
      ...base, title: `${HOOK_SCRIPT} is present but not executable in ${dir}`,
      state: "problem", severity: "warning",
      detail: `${scriptPath} exists but is not executable — chmod +x it.`,
    };
  }
  return {
    ...base, title: `${HOOK_SCRIPT} is installed and executable in ${dir}`,
    state: "ok", severity: "warning", detail: "",
  };
}

/** True when `matcher` covers the `compact` SessionStart source (README: `startup|resume|clear|compact`). */
function matchesCompact(matcher: string | undefined): boolean {
  return matcher?.includes("compact") ?? false;
}

/**
 * True when some entry under `event` registers a `command` hook resolving (via `resolveCommandPath`)
 * to the installed script. For `SessionStart` the matcher must additionally cover `compact` — the
 * one source whose absence silently loses the protocol at the moment a session most needs it (right
 * after a compaction).
 */
function eventRegistersHook(
  settings: Settings, event: "SessionStart" | "UserPromptSubmit", scriptPath: string, home: string | undefined,
): boolean {
  const entries = settings.hooks?.[event] ?? [];
  return entries.some((entry) => {
    if (event === "SessionStart" && !matchesCompact(entry.matcher)) return false;
    return entry.hooks.some((h) => resolveCommandPath(h.command, home) === scriptPath);
  });
}

/**
 * Registration is `n/a` when the script itself is not installed — there is nothing to register yet,
 * and reporting a registration problem on top would just be noise about the same missing file.
 */
function hookRegisteredCheck(deps: CheckDeps, envId: string, dir: string, now: number): Check {
  const scope = { kind: "configDir" as const, envId, dir };
  const base = {
    id: "ctx-hook-registered", key: checkKey("ctx-hook-registered", scope), scope, doc: DOC,
    class: "cheap" as const, checkedAt: now, startupOkLine: false, haltsStartup: false,
  };
  const scriptPath = `${dir}/${HOOK_SCRIPT}`;
  if (!deps.isFile(scriptPath) || !deps.isExec(scriptPath)) {
    return {
      ...base, title: `${HOOK_SCRIPT} registration not checked in ${dir}`,
      state: "n/a", severity: "warning",
      detail: `${HOOK_SCRIPT} is not installed in ${dir} — nothing to register yet.`,
    };
  }
  const result = readSettings(deps, dir);
  if (result.kind === "absent") {
    return {
      ...base, title: `no settings.json in ${dir}`,
      state: "problem", severity: "warning",
      detail: `Expected ${dir}/settings.json to register ${HOOK_SCRIPT} under SessionStart and UserPromptSubmit.`,
    };
  }
  if (result.kind === "malformed") {
    return {
      ...base, title: `settings.json in ${dir} could not be parsed`,
      state: "problem", severity: "warning",
      detail: `${dir}/settings.json is not valid JSON, so the hook registration could not be read.`,
    };
  }
  const home = deps.env.HOME;
  const sessionStartOk = eventRegistersHook(result.settings, "SessionStart", scriptPath, home);
  const userPromptOk = eventRegistersHook(result.settings, "UserPromptSubmit", scriptPath, home);
  if (sessionStartOk && userPromptOk) {
    return {
      ...base, title: `${HOOK_SCRIPT} registered under SessionStart and UserPromptSubmit in ${dir}`,
      state: "ok", severity: "warning", detail: "",
    };
  }
  const missing: string[] = [];
  if (!sessionStartOk) missing.push("SessionStart");
  if (!userPromptOk) missing.push("UserPromptSubmit");
  const sessionStartRegisteredButNoCompact =
    !sessionStartOk && (result.settings.hooks?.SessionStart ?? []).some((entry) =>
      entry.hooks.some((h) => resolveCommandPath(h.command, home) === scriptPath) && !matchesCompact(entry.matcher));
  const detail = sessionStartRegisteredButNoCompact
    ? `SessionStart is registered for ${scriptPath} but its matcher does not include "compact" — the context-pressure signal is lost exactly on the source that matters most.`
    : `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} missing a matcher entry whose command resolves to ${scriptPath} in ${dir}/settings.json.`;
  return { ...base, title: `${HOOK_SCRIPT} registration incomplete in ${dir}`, state: "problem", severity: "warning", detail };
}

/**
 * `<dir>/skills/corral/SKILL.md` must carry BOTH ctx-signal markers: the hook (line 24 of
 * corral-claude-hook.sh) `awk`s the block between them and exits silently on an empty result, so a
 * pre-marker copy of the skill looks installed while quietly disabling the hook. Severity drops to
 * `info` when the hook itself is not installed — then the skill is only an MCP recommendation, not a
 * broken link in an otherwise-working chain.
 */
function skillInstalledCheck(deps: CheckDeps, envId: string, dir: string, now: number): Check {
  const scope = { kind: "configDir" as const, envId, dir };
  const hookInstalled = deps.isFile(`${dir}/${HOOK_SCRIPT}`) && deps.isExec(`${dir}/${HOOK_SCRIPT}`);
  const severity = hookInstalled ? "warning" : "info";
  const base = {
    id: "corral-skill-installed", key: checkKey("corral-skill-installed", scope), scope, doc: DOC,
    class: "cheap" as const, checkedAt: now, startupOkLine: false, haltsStartup: false,
  };
  const skillPath = `${dir}/skills/corral/SKILL.md`;
  const text = deps.readText(skillPath);
  if (text === null) {
    return {
      ...base, title: `corral SKILL.md is missing in ${dir}`,
      state: "problem", severity,
      detail: `Expected ${skillPath}. Without it an un-primed session gets a raw context-pressure signal with no explanation.`,
    };
  }
  if (!text.includes(SIGNAL_START) || !text.includes(SIGNAL_END)) {
    return {
      ...base, title: `corral SKILL.md in ${dir} predates the ctx-signal markers`,
      state: "problem", severity,
      detail: `${skillPath} is missing the ${SIGNAL_START} / ${SIGNAL_END} markers — the hook's awk extraction finds an empty block and exits silently.`,
    };
  }
  return {
    ...base, title: `corral SKILL.md installed with ctx-signal markers in ${dir}`,
    state: "ok", severity, detail: "",
  };
}

/**
 * Three per-config-dir checks: `ctx-hook-installed`, `ctx-hook-registered`, `corral-skill-installed`.
 * LOCAL config dirs only — stage 1 has no remote handling here.
 */
export function ctxHookChecks(deps: CheckDeps, envId: string, dir: string): Check[] {
  const now = deps.now();
  return [
    hookInstalledCheck(deps, envId, dir, now),
    hookRegisteredCheck(deps, envId, dir, now),
    skillInstalledCheck(deps, envId, dir, now),
  ];
}

/**
 * Mirrors the hook's own jq predicate (corral-claude-hook.sh:45-53): an array of exactly three
 * numbers, strictly ascending.
 */
const ThresholdsSchema = z.tuple([z.number(), z.number(), z.number()])
  .refine(([a, b, c]) => a < b && b < c);

const ConfigSchema = z.object({
  hooks: z.object({ ctxThresholds: z.unknown().optional() }).optional(),
});

/**
 * GLOBAL, not per config dir — `$CORRAL_HOME/config.json` is one file on the machine running
 * corral, which the server itself never reads. An absent file and a present file with no
 * `hooks.ctxThresholds` key are both `ok`: the hook falls back to 30/40/60 for both identically
 * (corral-claude-hook.sh:45-53). A malformed file or thresholds that fail the predicate are
 * `problem`/`info` — the hook silently falls back, so it is a recommendation, not a failure.
 */
export function ctxThresholdsCheck(deps: CheckDeps, corralHome: string): Check {
  const scope = { kind: "global" as const };
  const base = {
    id: "ctx-thresholds", key: checkKey("ctx-thresholds", scope), scope, doc: DOC,
    class: "cheap" as const, checkedAt: deps.now(), startupOkLine: false, haltsStartup: false,
  };
  const configPath = `${corralHome}/config.json`;
  const text = deps.readText(configPath);
  if (text === null) {
    return {
      ...base, title: `no ${configPath} — using the default thresholds`,
      state: "ok", severity: "info", detail: "",
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ...base, title: `${configPath} could not be parsed`,
      state: "problem", severity: "info",
      detail: `${configPath} is not valid JSON — the hook silently falls back to the default thresholds (30/40/60).`,
    };
  }
  const parsedConfig = ConfigSchema.safeParse(json);
  if (!parsedConfig.success) {
    return {
      ...base, title: `${configPath} could not be parsed`,
      state: "problem", severity: "info",
      detail: `${configPath} does not match the expected shape — the hook silently falls back to the default thresholds (30/40/60).`,
    };
  }
  const raw = parsedConfig.data.hooks?.ctxThresholds;
  if (raw === undefined) {
    return {
      ...base, title: `${configPath} sets no ctxThresholds — using the default thresholds`,
      state: "ok", severity: "info", detail: "",
    };
  }
  const parsed = ThresholdsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ...base, title: `hooks.ctxThresholds in ${configPath} is not three strictly-ascending numbers`,
      state: "problem", severity: "info",
      detail: `${configPath} sets hooks.ctxThresholds to ${JSON.stringify(raw)} — the hook requires exactly three ascending numbers and silently falls back to 30/40/60 otherwise.`,
    };
  }
  return {
    ...base, title: `hooks.ctxThresholds in ${configPath} is valid`,
    state: "ok", severity: "info", detail: "",
  };
}
