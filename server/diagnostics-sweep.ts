import type { Check, CheckClass, CheckDoc, CheckSeverity } from "@shared/diagnostics-schema";
import { checkKey } from "@shared/diagnostics-schema";
import type { Snapshot } from "@shared/schema";

import type { HerdrEnv } from "../environments.ts";
import { envReachableChecks, suppressUnrunnable } from "./diagnostics/cascade.ts";
import { ctxHookChecks, ctxThresholdsCheck } from "./diagnostics/ctx-hook.ts";
import type { CheckDeps } from "./diagnostics/deps.ts";
import { resolveOnPath } from "./diagnostics/deps.ts";
import { driftCheck, themeCheck } from "./diagnostics/drift.ts";
import { envChecks, nodeVersionCheck } from "./diagnostics/env.ts";
import { metricsChecks } from "./diagnostics/metrics.ts";
import type { ReportLine } from "./diagnostics/render.ts";
import { buildStartupChecks, findMissingBinaries } from "./diagnostics/startup.ts";
import { versionChecks } from "./diagnostics/versions.ts";
import type { DiagnosticsStore } from "./diagnostics-store.ts";
import type { RunTool } from "./exec-tool.ts";
import { runGuarded } from "./scheduler.ts";

export interface SweepOpts {
  readonly store: DiagnosticsStore;
  readonly poller: { getSnapshot: () => Snapshot };
  readonly envs: readonly HerdrEnv[];
  readonly deps: CheckDeps;
  readonly corralHome: string;
  /**
   * The line `runPreflight` already produced, handed over rather than re-derived: environments.ts
   * evaluates ENVIRONMENTS at module scope and the dynamic import is cached, so a second load returns
   * the first result. Re-deriving could only repeat this line or describe a config this process is not
   * running. Picking up an edited environments.json is a restart, and a separate feature.
   */
  readonly configLine: ReportLine;
  readonly run: RunTool;
  /** 0 disables the background loop — the design's off switch, without a second boolean knob. */
  readonly intervalMs: number;
  readonly versionTtlMs: number;
  readonly warn?: (msg: string) => void;
}

export interface DiagnosticsSweep {
  /** Timer path: collapses onto a run already in flight rather than queueing behind it. */
  readonly tick: () => Promise<void>;
  /**
   * Recheck path: waits out any run in flight, then runs ONE more with the version TTL bypassed — so
   * the answer it returns post-dates the request. Joining the in-flight run would not do: that run
   * started before the operator asked, and is still inside the version TTL, so it would hand back the
   * pre-upgrade verdict.
   */
  readonly refresh: () => Promise<void>;
  readonly start: () => () => void;
}

/**
 * The per-config-dir subjects the LOCAL producers own (`metrics.ts`, `ctx-hook.ts`, `drift.ts`),
 * mirrored here as `pending` rows for a REMOTE config dir. Those producers stat and hash paths on the
 * machine they run on, so running them for a remote env's dirs would publish a verdict about THIS
 * disk under that environment's name — a green row for a file that is not there, which is the exact
 * silent lie this feature exists to remove.
 *
 * The ids, severities and doc anchors mirror the producers deliberately. `enumerateChecks()` includes
 * a remote environment, so Task 14's anchor guard reaches these rows too: a wrong anchor here fails
 * that guard rather than shipping a dead README link.
 */
const REMOTE_DIR_SUBJECTS: readonly {
  readonly id: string;
  readonly label: string;
  readonly severity: CheckSeverity;
  readonly doc: CheckDoc;
}[] = [
  { id: "capture-script", label: "corral-status-capture.sh", severity: "warning", doc: { anchor: "installing-the-claude-helper-files-per-config-dir", title: "Installing the helper files" } },
  { id: "statusline-registered", label: "statusline registration", severity: "warning", doc: { anchor: "claude-statusline-live-metrics", title: "Claude statusline" } },
  { id: "ctx-hook-installed", label: "corral-claude-hook.sh", severity: "warning", doc: { anchor: "claude-context-pressure-hook", title: "Context-pressure hook" } },
  { id: "ctx-hook-registered", label: "context-pressure hook registration", severity: "warning", doc: { anchor: "claude-context-pressure-hook", title: "Context-pressure hook" } },
  { id: "corral-skill-installed", label: "corral SKILL.md", severity: "info", doc: { anchor: "claude-context-pressure-hook", title: "Context-pressure hook" } },
  { id: "helper-drift", label: "installed helper files", severity: "warning", doc: { anchor: "upgrading", title: "Upgrading" } },
  { id: "theme-installed", label: "corral theme preset", severity: "info", doc: { anchor: "claude-theme-optional", title: "Claude theme" } },
];

function remoteDirChecks(envId: string, dir: string, now: number): Check[] {
  return REMOTE_DIR_SUBJECTS.map((s) => {
    const scope = { kind: "configDir" as const, envId, dir };
    return {
      id: s.id, key: checkKey(s.id, scope), scope,
      title: `${s.label}: ${dir} is on a remote host — not checked here`,
      state: "pending" as const, severity: s.severity,
      detail: `environment "${envId}" is remote — its config dir lives on the far host, so this can only be checked there.`,
      doc: s.doc, class: "cheap" as const, checkedAt: now,
      startupOkLine: false, haltsStartup: false,
    };
  });
}

/**
 * First occurrence wins. `configDirsChecks` is called by BOTH `buildStartupChecks` (the launch report
 * needs the row) and `envChecks` (the panel's per-environment set needs it), so composing the two
 * yields one duplicate `claude-config-dirs` key. `key` is the panel's React key and stage 2's
 * auto-expand signature key, so a duplicate is a rendering bug rather than a cosmetic one.
 */
function dedupeByKey(checks: readonly Check[]): Check[] {
  const seen = new Set<string>();
  const out: Check[] = [];
  for (const c of checks) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    out.push(c);
  }
  return out;
}

interface ComposeInput {
  readonly deps: CheckDeps;
  readonly envs: readonly HerdrEnv[];
  readonly snapshot: Snapshot;
  readonly configLine: ReportLine;
  readonly corralHome: string;
}

/**
 * Every non-version row, in the order the design fixes: the startup set first (so the panel and the
 * launch report cannot disagree about it), then the global runtime rows, the per-environment rows, the
 * per-config-dir rows — local checked, remote `pending` — and finally the poller's reachability view.
 */
function cheapChecks(input: ComposeInput): Check[] {
  const { deps, envs } = input;
  const now = deps.now();
  const missing = findMissingBinaries(envs, (bin) => resolveOnPath(bin, deps.pathEnv, deps.isExec));
  const checks: Check[] = [
    ...buildStartupChecks({ env: deps.env, envs, configLine: input.configLine, missing, pathEnv: deps.pathEnv }),
    nodeVersionCheck(deps),
    ...envChecks(deps, envs, input.snapshot.sessions),
  ];
  for (const env of envs) {
    for (const dir of env.claudeConfigDirs) {
      if (env.kind === "remote") {
        checks.push(...remoteDirChecks(env.id, dir, now));
        continue;
      }
      checks.push(
        ...metricsChecks(deps, env.id, dir),
        ...ctxHookChecks(deps, env.id, dir),
        driftCheck(deps, env.id, dir),
        themeCheck(deps, env.id, dir),
      );
    }
  }
  checks.push(ctxThresholdsCheck(deps, input.corralHome));
  checks.push(...envReachableChecks(input.snapshot.envs, now));
  return dedupeByKey(checks);
}

/**
 * The Claude CLI version the statusline last reported, per environment — `versionChecks`'s fallback
 * for when `claude --version` cannot be run. Newest capture per environment wins; sessions the
 * statusline never reached contribute nothing rather than a null that would shadow a live sibling.
 */
function ccVersionByEnv(snapshot: Snapshot): Record<string, string> {
  const byEnv: Record<string, string> = {};
  const capturedAt = new Map<string, number>();
  for (const row of snapshot.sessions) {
    const version = row.statusline?.cc_version ?? null;
    if (version === null) continue;
    const at = row.statusline?.captured_at ?? 0;
    if ((capturedAt.get(row.env) ?? -1) >= at) continue;
    capturedAt.set(row.env, at);
    byEnv[row.env] = version;
  }
  return byEnv;
}

const unreachableIds = (snapshot: Snapshot): ReadonlySet<string> =>
  new Set(Object.entries(snapshot.envs).filter(([, s]) => !s.reachable).map(([id]) => id));

/**
 * Files the composed rows under their own classes, after collapsing whatever an unreachable
 * environment's herdr made unrunnable. The suppression runs over cheap and version rows TOGETHER: it
 * is the version probes that need herdr, and its one `env-unrunnable` summary row per environment
 * would be emitted twice — the same key twice in one snapshot — if each class were suppressed apart.
 *
 * `cheap` and `versions` are always written, even empty: presence of the key is what tells the rail
 * "this class has answered" apart from "nothing has run yet".
 */
function publish(
  store: DiagnosticsStore, rows: readonly Check[], unreachable: ReadonlySet<string>, now: number,
): void {
  const byClass = new Map<CheckClass, Check[]>([["cheap", []], ["versions", []]]);
  for (const c of suppressUnrunnable(rows, unreachable, now)) {
    const bucket = byClass.get(c.class);
    if (bucket === undefined) byClass.set(c.class, [c]);
    else bucket.push(c);
  }
  for (const [cls, checks] of byClass) store.put(cls, checks);
}

export function createDiagnosticsSweep(opts: SweepOpts): DiagnosticsSweep {
  const warn = opts.warn ?? ((msg: string): void => { console.warn(msg); });
  // Warned-about messages, never cleared: the point is one line per DISTINCT failure, not one per
  // tick — a sweep that throws the same error every 60 s must not fill the log with it.
  const warned = new Set<string>();
  // The version rows outlive their tick: they are the expensive ones, so a tick inside the TTL
  // republishes the cached set rather than re-probing. Cached PRE-suppression, so a reachability
  // change is reflected on the next tick without a probe.
  let versionRows: readonly Check[] = [];
  let versionsAt: number | null = null;

  /** Total by construction — the try/catch is inside it, so neither path can reject. */
  const runOnce = async (bypassVersionTtl: boolean): Promise<void> => {
    try {
      const now = opts.deps.now();
      const snapshot = opts.poller.getSnapshot();
      const input: ComposeInput = {
        deps: opts.deps, envs: opts.envs, snapshot,
        configLine: opts.configLine, corralHome: opts.corralHome,
      };
      const cheap = cheapChecks(input);
      const stale = versionsAt === null || now - versionsAt >= opts.versionTtlMs;
      if (bypassVersionTtl || stale) {
        versionRows = await versionChecks({
          envs: opts.envs, run: opts.run,
          ccVersionByEnv: ccVersionByEnv(snapshot), now: opts.deps.now,
        });
        versionsAt = now;
      }
      publish(opts.store, [...cheap, ...versionRows], unreachableIds(snapshot), now);
      opts.store.setLastError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The class results are deliberately left standing, so the snapshot would otherwise go on
      // looking exactly like a healthy one — `lastError` is the whole difference.
      opts.store.setLastError(msg);
      if (!warned.has(msg)) {
        warned.add(msg);
        warn(`[diagnostics] sweep failed (results may be stale): ${msg}`);
      }
    }
  };

  let inFlight: Promise<void> | null = null;
  const begin = (p: Promise<void>): Promise<void> => {
    inFlight = p.finally(() => { inFlight = null; });
    return inFlight;
  };

  // Timer path: collapse onto whatever is already running. Cheap, and the next tick is 60 s away.
  const tick = (): Promise<void> => inFlight ?? begin(runOnce(false));

  // Recheck path: let the in-flight run finish, then run again, ignoring the version TTL.
  const refresh = async (): Promise<void> => {
    if (inFlight !== null) await inFlight;
    await begin(runOnce(true));
  };

  return {
    tick,
    refresh,
    // `tick` is already self-collapsing, which is exactly the split `runGuarded` exists for.
    start: () => runGuarded(tick, opts.intervalMs),
  };
}

/** Deps that answer "nothing is installed" to everything, so no enumeration touches a real disk. */
const INERT_DEPS: CheckDeps = {
  env: {}, pathEnv: "", nodeVersion: "0.0.0",
  isFile: () => false, isExec: () => false, isDir: () => false,
  readText: () => null, hashFile: () => null,
  repoRoot: "/repo", now: () => 0,
};

const ENUMERATE_ENVS: readonly HerdrEnv[] = [
  { id: "local", label: "local", kind: "local", claudeConfigDirs: ["/cfg"], spawnCommand: "claude", repos: {} },
  { id: "remote", label: "remote", kind: "remote", sshHost: "host", socket: "/sock", herdrBin: "herdr", claudeConfigDirs: ["/cfg"], spawnCommand: "claude", repos: {} },
  // A third, UNREACHABLE environment: `env-unrunnable` is a producer too, and it exists only once
  // some check has been suppressed. Its version rows are the ones suppressed, and both of those ids
  // still appear via the two environments above, so nothing is lost from the enumeration.
  { id: "down", label: "down", kind: "local", claudeConfigDirs: ["/cfg"], spawnCommand: "claude", repos: {} },
];

/**
 * Every producer run against inert stub dependencies — the enumeration of every row corral can
 * produce, for guards that must reason about the whole check set (Task 14's README-anchor guard).
 *
 * Async because `versionChecks` is: a synchronous version would silently drop every `versions` row,
 * which is precisely the set whose anchors that guard exists to verify.
 *
 * One row per SUBJECT, not per branch: `INERT_DEPS.env` is empty, so the alternative branches that
 * only an environment variable selects (`under-claude-override`, `socket-unpinned`) do not appear.
 * Neither carries a doc anchor of its own — the first shares `launch-under-claude`'s, the second has
 * none — so the anchor set is still complete. A guard that needs every branch must vary `env` itself.
 */
export async function enumerateChecks(): Promise<Check[]> {
  const snapshot: Snapshot = {
    envs: { local: { reachable: true }, remote: { reachable: true }, down: { reachable: false, error: "unreachable" } },
    sessions: [],
  };
  const cheap = cheapChecks({
    deps: INERT_DEPS, envs: ENUMERATE_ENVS, snapshot,
    configLine: { level: "ok", text: "config: 3 environment(s) loaded" },
    corralHome: "/corral-home",
  });
  const versions = await versionChecks({
    envs: ENUMERATE_ENVS, run: () => Promise.resolve(null), ccVersionByEnv: {}, now: () => 0,
  });
  return suppressUnrunnable([...cheap, ...versions], unreachableIds(snapshot), 0);
}
