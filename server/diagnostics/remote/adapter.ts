import type { Check, CheckScope } from "@shared/diagnostics-schema";
import { checkKey } from "@shared/diagnostics-schema";

import { ctxHookChecks } from "../ctx-hook.ts";
import { pathCandidates, resolveCommandPath } from "../deps.ts";
import { DRIFT_FILES, driftCheck, themeCheck } from "../drift.ts";
import { configDirExistsChecks, jqPresentCheck } from "../env.ts";
import { metricsChecks, SettingsSchema } from "../metrics.ts";
import type { Settings } from "../metrics.ts";
import { claudeCliVersionCheck, herdrVersionCheck, integrationCheckAt } from "../versions.ts";
import type { VersionCheckOpts } from "../versions.ts";
import type { ProbeFacts, Round2Planner } from "./probe.ts";
import { createDepsRecorder, createRunRecorder, NEGATIVE_FACTS } from "./recorder.ts";
import type { FactSource } from "./recorder.ts";
import type { RemoteEnv, Round2Request } from "./script.ts";
import { screenRound2Path } from "./script.ts";

export interface RemoteRowsOpts {
  readonly env: RemoteEnv;
  /** null = no probe ran (disabled / enumerate) — the fact-free composition path. */
  readonly probe: ProbeFacts | null;
  /** reason text used when probe is null or wholly unanswered ("probe disabled (REMOTE_PROBE_ENABLED=false)" / "SSH failed: …") */
  readonly reason: string | null;
  readonly repoRoot: string;
  readonly nodeVersion: string;
  readonly now: () => number;
  readonly localHash: (p: string) => string | null;
  readonly ccVersion: string | null; // ccVersionByEnv[env.id] ?? null
}

interface DirScope {
  readonly scope: CheckScope;
  readonly extraEnv: Readonly<Record<string, string>> | undefined;
}

/** Mirrors `integrationChecks` (versions.ts): one call per config dir, or one env-scoped call with none. */
function dirScopes(env: RemoteEnv): readonly DirScope[] {
  if (env.claudeConfigDirs.length === 0) {
    return [{ scope: { kind: "env", envId: env.id }, extraEnv: undefined }];
  }
  return env.claudeConfigDirs.map((dir) => ({
    scope: { kind: "configDir", envId: env.id, dir },
    extraEnv: { CLAUDE_CONFIG_DIR: dir },
  }));
}

/** `SettingsSchema.safeParse(JSON.parse(text))`, never throwing — text the probe already fetched. */
export function parseSettingsText(text: string): Settings | null {
  try {
    const parsed = SettingsSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Round-2 requests for one remote environment: jq candidates off the login-shell PATH, plus each
 * config dir's statusline script (resolved from `settings.json`, which round F already fetched).
 * Screened-out or non-absolute paths are recorded in `rejected` for `remote-probe`'s detail text —
 * the producer itself will find the path unanswered and the per-call rewrite marks
 * `statusline-registered` `n/a`, so no extra row surgery is needed here.
 */
export function planRound2For(env: RemoteEnv): Round2Planner {
  return (facts) => {
    const requests: Round2Request[] = [];
    const rejected: { path: string; reason: string }[] = [];
    let n = 0;
    const key = (): string => {
      const k = `r2_${String(n)}`;
      n += 1;
      return k;
    };
    if (facts.pathEnv !== null) {
      for (const p of pathCandidates("jq", facts.pathEnv)) {
        if (screenRound2Path(p)) requests.push({ key: key(), kind: "exec", path: p });
        else rejected.push({ path: p, reason: "PATH entry failed the metacharacter screen" });
      }
    }
    for (const dir of env.claudeConfigDirs) {
      const raw = facts.byPath.get(`${dir}/settings.json`);
      if (raw?.kind !== "content") continue;
      const parsed = parseSettingsText(raw.bytes.toString("utf8"));
      const command = parsed?.statusLine?.type === "command" ? parsed.statusLine.command : null;
      if (command === null) continue;
      const p = resolveCommandPath(command, facts.home ?? undefined);
      if (p === "" || !p.startsWith("/")) rejected.push({ path: p, reason: "not an absolute path" });
      else if (!screenRound2Path(p)) rejected.push({ path: p, reason: "failed the metacharacter screen" });
      else requests.push({ key: key(), kind: "file", path: p });
    }
    return { requests, rejected };
  };
}

/**
 * The single composition path serving probe-ok, probe-partial, probe-failed, probe-disabled and
 * enumeration: run every LOCAL producer, unmodified, over a recording facade fed by remote-probed
 * facts (or `NEGATIVE_FACTS` when the whole probe is fact-free), then rewrite the rows any call
 * could not honestly answer to `n/a` — per producer CALL, not per row, which over-drops by design
 * (constraint: a false red is worse than a missing row).
 */
export async function composeRemoteRows(opts: RemoteRowsOpts): Promise<readonly Check[]> {
  const { env, probe, reason, repoRoot, nodeVersion, now, localHash, ccVersion } = opts;

  // Step 1: the FactSource. A whole-host miss (no probe, or a probe that answered NOTHING) falls
  // back to the synthetically-complete answered-negative map — row SHELLS still come from running
  // the producers over it, then the rewrite step below turns every one of those shells to n/a.
  const factSource: FactSource = probe === null || probe.arrived === 0
    ? NEGATIVE_FACTS
    : { lookup: (p) => probe.byPath.get(p), home: probe.home, pathEnv: probe.pathEnv };

  const localHashPaths = new Set(DRIFT_FILES.map(([, repo]) => `${repoRoot}/${repo}`));
  const rec = createDepsRecorder(factSource, { repoRoot, nodeVersion, now, localHashPaths, localHash });
  const runRec = createRunRecorder(probe?.tools ?? new Map());

  // Step 2: run every producer call through the recorders, draining after EACH call — per-call
  // granularity, deliberate: a call whose result touched even one unanswered path loses ALL of its
  // rows, not just the affected one.
  const calls: { rows: Check[]; unanswered: readonly string[] }[] = [];
  const call = (rows: Check | Check[]): void => {
    calls.push({ rows: Array.isArray(rows) ? rows : [rows], unanswered: rec.drain() });
  };

  const nowMs = now();
  call(jqPresentCheck(rec.deps, env, nowMs));
  call(configDirExistsChecks(rec.deps, env, nowMs));
  for (const dir of env.claudeConfigDirs) {
    call(metricsChecks(rec.deps, env.id, dir));
    call(ctxHookChecks(rec.deps, env.id, dir));
    call(driftCheck(rec.deps, env.id, dir));
    call(themeCheck(rec.deps, env.id, dir));
  }

  // Version leg — the exported producers over the recording RunTool (async). Sequential: three
  // short map lookups, no exec; concurrency buys nothing and per-call draining requires ordering.
  const vOpts: VersionCheckOpts = {
    envs: [env], run: runRec.run,
    ccVersionByEnv: ccVersion === null ? {} : { [env.id]: ccVersion },
    now,
  };
  const vCall = async (p: Promise<Check> | Promise<Check[]>): Promise<void> => {
    const rows = await p;
    calls.push({ rows: Array.isArray(rows) ? rows : [rows], unanswered: runRec.drain() });
  };
  await vCall(herdrVersionCheck(vOpts, env, nowMs));
  await vCall(claudeCliVersionCheck(vOpts, env, nowMs));
  for (const scopeDir of dirScopes(env)) {
    await vCall(integrationCheckAt(vOpts, env, scopeDir.scope, scopeDir.extraEnv, nowMs));
  }

  // Step 3: the rewrite. `wholeProbeReason` is set (not null) exactly when EVERY call must be
  // rewritten for the same fixed reason — a disabled probe or a clean whole-host failure. Left
  // null for a healthy or partial probe, where each call's own `unanswered` list (if any) supplies
  // its reason instead.
  const wholeProbeReason: string | null =
    probe === null ? (reason ?? "the remote probe is disabled")
    : probe.arrived === 0 ? (reason ?? probe.error ?? "the remote probe failed")
    : null;
  const rewriteReason = (subjects: readonly string[]): string =>
    wholeProbeReason ?? `not known this round — did not arrive: ${subjects.join(", ")}`;
  const rewrite = (c: Check, why: string): Check => ({
    ...c, state: "n/a", title: `${c.id} for "${env.id}": ${why}`, detail: "",
  });

  const rows: Check[] = [];
  const rewrittenSubjectIds = new Set<string>();
  for (const { rows: callRows, unanswered } of calls) {
    if (wholeProbeReason === null && unanswered.length === 0) {
      rows.push(...callRows);
      continue;
    }
    const why = rewriteReason(unanswered);
    for (const c of callRows) {
      rows.push(rewrite(c, why));
      rewrittenSubjectIds.add(c.id);
    }
  }

  // Step 4: re-stamp every row remote — the store replaces classes wholesale, and rows on a
  // 30-minute TTL filed under `cheap` would vanish every 60-s sweep.
  const stamped = rows.map((c): Check => ({ ...c, class: "remote" }));

  // Step 5: the unconditional remote-probe row.
  stamped.push(remoteProbeRow(opts, nowMs, rewrittenSubjectIds));

  return stamped;
}

const REMOTE_PROBE_DOC = { anchor: "environments", title: "Environments" };

function remoteProbeRow(opts: RemoteRowsOpts, nowMs: number, rewrittenSubjectIds: ReadonlySet<string>): Check {
  const { env, probe, reason } = opts;
  const scope: CheckScope = { kind: "env", envId: env.id };
  const base = {
    id: "remote-probe", key: checkKey("remote-probe", scope), scope,
    doc: REMOTE_PROBE_DOC, class: "remote" as const, checkedAt: nowMs,
    startupOkLine: false, haltsStartup: false, severity: "warning" as const, detail: "",
  };
  if (probe === null) {
    return { ...base, state: "n/a", title: reason ?? "the remote probe is disabled" };
  }
  if (probe.arrived === 0) {
    return { ...base, state: "n/a", title: `remote probe failed for "${env.id}": ${probe.error ?? "no answer"}` };
  }
  if (probe.expected > 0 && probe.arrived === probe.expected) {
    return { ...base, state: "ok", title: `remote probe answered for "${env.id}" (${new Date(nowMs).toISOString()})` };
  }
  return {
    ...base, state: "problem",
    title: `remote probe partial for "${env.id}" — unanswered: ${[...rewrittenSubjectIds].join(", ")}`,
  };
}
