import type { Check, CheckClass } from "@shared/diagnostics-schema";
import type { Snapshot } from "@shared/schema";

import type { HerdrEnv } from "../environments.ts";
import { envReachableChecks, suppressUnrunnable } from "./diagnostics/cascade.ts";
import { ctxHookChecks, ctxThresholdsCheck } from "./diagnostics/ctx-hook.ts";
import type { CheckDeps } from "./diagnostics/deps.ts";
import { resolveOnPath } from "./diagnostics/deps.ts";
import { driftCheck, themeCheck } from "./diagnostics/drift.ts";
import { envChecks, nodeVersionCheck } from "./diagnostics/env.ts";
import { metricsChecks } from "./diagnostics/metrics.ts";
import { composeRemoteRows, planRound2For } from "./diagnostics/remote/adapter.ts";
import type { RemoteRowsOpts } from "./diagnostics/remote/adapter.ts";
import { runProbe } from "./diagnostics/remote/probe.ts";
import type { ProbeFacts } from "./diagnostics/remote/probe.ts";
import type { RemoteEnv } from "./diagnostics/remote/script.ts";
import type { ReportLine } from "./diagnostics/render.ts";
import { buildStartupChecks, findMissingBinaries } from "./diagnostics/startup.ts";
import type { UpdateCheckIo } from "./diagnostics/update/check.ts";
import { updateCheck } from "./diagnostics/update/check.ts";
import { versionChecks } from "./diagnostics/versions.ts";
import type { DiagnosticsStore } from "./diagnostics-store.ts";
import type { RunTool } from "./exec-tool.ts";
import type { ExecFn } from "./herdr.ts";
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
  /** SSH transport for the remote probe — injected so no test performs a real connection. */
  readonly probeExec: ExecFn;
  /** REMOTE_PROBE_ENABLED (config.ts). Off: remote rows compose as n/a naming the switch; no exec. */
  readonly remoteProbeEnabled: boolean;
  /**
   * The update check's I/O — `fetch`, the on-disk cache and the repository reader — injected for the
   * same reason `probeExec` is: no test, and no `enumerateChecks` run, may perform a real request.
   * `enabled` is UPDATE_CHECK_ENABLED.
   */
  readonly updateIo: UpdateCheckIo;
}

export interface DiagnosticsSweep {
  /** Timer path: collapses onto a run already in flight rather than queueing behind it. */
  readonly tick: () => Promise<void>;
  /**
   * Recheck path: waits out any run in flight, then runs ONE more with the version TTL bypassed — so
   * the answer it returns post-dates the request. Joining the in-flight run would not do: that run
   * started before the operator asked, and is still inside the version TTL, so it would hand back the
   * pre-upgrade verdict. Subject to the remote floor — remote rows inside the 60-second floor answer
   * from the cache; the panel's own `checkedAt` age is what the operator sees in that window.
   */
  readonly refresh: () => Promise<void>;
  readonly start: () => () => void;
}

/**
 * The one id this module composes twice BY DESIGN. `configDirsChecks` is called by both
 * `buildStartupChecks` (the launch report needs the row) and `envChecks` (the panel's per-environment
 * set needs it); both are the right owners of their own output, so the reconciliation belongs here, in
 * the module that composes them.
 */
const EXPECTED_DUPLICATE_IDS: ReadonlySet<string> = new Set(["claude-config-dirs"]);

const REMOTE_TTL_MS = 1_800_000;        // R11: 30-minute success TTL — the TTL IS the cache
const REMOTE_FAILURE_TTL_MS = 300_000;  // 5 minutes: a transient blip must not cost 30 min of blindness
const REMOTE_REFRESH_FLOOR_MS = 60_000; // Recheck bypasses the TTL but honours this per-env floor

interface RemoteCacheEntry {
  readonly rows: readonly Check[];
  readonly at: number;
  readonly ok: boolean;
}

/**
 * Drops a repeat of an EXPECTED duplicate id only — first occurrence wins, which keeps the startup
 * row, the same one the launch report printed.
 *
 * Deliberately not a general dedupe: `key` is the panel's React key and stage 2's auto-expand
 * signature key, so a NEW producer colliding with an existing row is a bug, and a blanket
 * first-wins filter would absorb it silently AND leave the duplicate-key test below unable to fail.
 * Everything not named above falls through untouched, so any other collision still surfaces.
 */
function dropExpectedDuplicates(checks: readonly Check[]): Check[] {
  const seen = new Set<string>();
  const out: Check[] = [];
  for (const c of checks) {
    // Equal keys imply equal ids (`checkKey` builds the key FROM the id), so testing the incoming
    // row's id is the same test as "the row already kept under this key has that id".
    if (seen.has(c.key) && EXPECTED_DUPLICATE_IDS.has(c.id)) continue;
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
 * per-config-dir rows — local only, remote envs skipped (the remote class owns those) — and finally
 * the poller's reachability view.
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
    if (env.kind === "remote") continue; // the remote class owns these rows (adapter, Task 12)
    for (const dir of env.claudeConfigDirs) {
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
  return dropExpectedDuplicates(checks);
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

/**
 * Local envs only — R16: the SSH attempt IS a remote env's own gate, so an unreachable remote never
 * lands in this set (never collapses to `env-unrunnable`; its own probed rows are its truth).
 * `envs` (the config), not `snapshot.envs[id].kind`, is the authority: `EnvState.kind` is optional
 * and unset in fixtures, so filtering on the snapshot would silently treat every fixture env as
 * local and defeat the regression this edit exists for.
 */
const unreachableIds = (envs: readonly HerdrEnv[], snapshot: Snapshot): ReadonlySet<string> => {
  const remote = new Set(envs.filter((e) => e.kind === "remote").map((e) => e.id));
  return new Set(Object.entries(snapshot.envs)
    .filter(([id, s]) => !s.reachable && !remote.has(id)).map(([id]) => id));
};

/**
 * Files the composed rows under their own classes, after collapsing whatever an unreachable
 * environment's herdr made unrunnable. The suppression runs over cheap and version rows TOGETHER: it
 * is the version probes that need herdr, and its one `env-unrunnable` summary row per environment
 * would be emitted twice — the same key twice in one snapshot — if each class were suppressed apart.
 *
 * Every class is always written, even empty: presence of the key is what tells the rail "this class
 * has answered" apart from "nothing has run yet" — an all-local fleet must still be able to tell "no
 * remote environments" from "the remote class has never run".
 *
 * The seed lands here, in this one final pass, and NEVER as a separate early `put`. The store
 * replaces a class wholesale, so an early `put(cls, [])` would blank that class's live row for the
 * rest of the tick, and the empty window is observable over /api/diagnostics and /api/stream.
 */
function publish(
  store: DiagnosticsStore, rows: readonly Check[], unreachable: ReadonlySet<string>, now: number,
): void {
  const byClass = new Map<CheckClass, Check[]>([
    ["cheap", []], ["versions", []], ["remote", []], ["network", []],
  ]);
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
  // Cached PRE-suppression, keyed by env id. Per-env cadence (TTL/floor) lives on `runOnce`'s own
  // `now`/`manual`, not in here — the entry only remembers when it last actually ran and whether
  // that run succeeded.
  const remoteCache = new Map<string, RemoteCacheEntry>();

  /**
   * Probes each remote env per the cadence rules and composes its rows, reusing the cached rows when
   * neither the TTL/floor is due. Every env's task is wrapped in its own catch resolving to the
   * fact-free composition with the error as reason: `runProbe` already cannot reject (Task 7), but
   * the composition around it must ALSO never escape — one dead environment must never take another
   * env's rows, the cheap rows, or `publish` itself down. `Promise.all` below is safe only because
   * every element is total by construction.
   */
  const remoteLeg = async (snapshot: Snapshot, now: number, manual: boolean): Promise<Check[]> => {
    const remoteEnvs = opts.envs.filter((e): e is RemoteEnv => e.kind === "remote");
    const ccByEnv = ccVersionByEnv(snapshot);

    const isDue = (entry: RemoteCacheEntry): boolean => {
      const threshold = manual ? REMOTE_REFRESH_FLOOR_MS : (entry.ok ? REMOTE_TTL_MS : REMOTE_FAILURE_TTL_MS);
      return now - entry.at >= threshold;
    };

    const composeOpts = (env: RemoteEnv, probe: ProbeFacts | null, reason: string | null): RemoteRowsOpts => ({
      env, probe, reason,
      repoRoot: opts.deps.repoRoot, nodeVersion: opts.deps.nodeVersion,
      now: opts.deps.now, localHash: opts.deps.hashFile,
      ccVersion: ccByEnv[env.id] ?? null,
    });

    const perEnv = await Promise.all(remoteEnvs.map(async (env): Promise<readonly Check[]> => {
      const cached = remoteCache.get(env.id);
      if (cached !== undefined && !isDue(cached)) return cached.rows;
      try {
        if (!opts.remoteProbeEnabled) {
          const rows = await composeRemoteRows(
            composeOpts(env, null, "remote probe disabled (REMOTE_PROBE_ENABLED=false)"),
          );
          remoteCache.set(env.id, { rows, at: now, ok: true }); // nothing to retry faster for
          return rows;
        }
        const probe = await runProbe(env, opts.probeExec, planRound2For(env));
        const rows = await composeRemoteRows(composeOpts(env, probe, null));
        // A permanently-partial host (e.g. no bash → $PATH never answers) stays ok:false forever by
        // design — the 5-min retry and standing `problem` row are the honest state. Classifying on
        // `arrived === 0` instead would hide an ongoing partial answer behind the 30-min TTL: the
        // false-green this design exists to avoid.
        const ok = probe.arrived === probe.expected && probe.expected > 0;
        remoteCache.set(env.id, { rows, at: now, ok });
        return rows;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          const rows = await composeRemoteRows(composeOpts(env, null, msg));
          remoteCache.set(env.id, { rows, at: now, ok: false });
          return rows;
        } catch {
          // composeRemoteRows itself failing on the fallback path is a bug in that call, not a
          // reason to take the whole sweep down — this env answers nothing THIS round, every other
          // env (and the cheap rows, and publish) still runs.
          return [];
        }
      }
    }));
    return perEnv.flat();
  };

  /** Total by construction — the try/catch is inside it, so neither path can reject. */
  const runOnce = async (manual: boolean): Promise<void> => {
    try {
      const now = opts.deps.now();
      const snapshot = opts.poller.getSnapshot();
      const input: ComposeInput = {
        deps: opts.deps, envs: opts.envs, snapshot,
        configLine: opts.configLine, corralHome: opts.corralHome,
      };
      const cheap = cheapChecks(input);
      const stale = versionsAt === null || now - versionsAt >= opts.versionTtlMs;
      if (manual || stale) {
        versionRows = await versionChecks({
          envs: opts.envs, run: opts.run,
          ccVersionByEnv: ccVersionByEnv(snapshot), now: opts.deps.now,
        });
        versionsAt = now;
      }
      // Together, not one after the other: the two legs share no I/O, and `publish` below is the
      // single write for every class, so a serial update check would put GitHub's 8 s deadline on
      // top of the remote budget before ANY row reached the panel — worst on the first tick after a
      // launch, which is the moment this feature exists for.
      //
      // The update check rides the tick behind its own cache, and a Recheck deliberately does not
      // bypass it: /api/diagnostics/refresh is unauthenticated and floored at 2 s, which is 30
      // requests a minute against a 60/hour budget.
      const [remoteRows, update] = await Promise.all([
        remoteLeg(snapshot, now, manual),
        updateCheck(opts.updateIo, opts.deps.now),
      ]);
      opts.store.patchSelf(update.self);
      publish(opts.store, [...cheap, ...versionRows, ...remoteRows, update.check],
        unreachableIds(opts.envs, snapshot), now);
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

  /** The LAST link of the run chain, or null when nothing is running. Never two live links. */
  let inFlight: Promise<void> | null = null;

  /**
   * Appends one run to the chain and publishes it as the new tail, both in the SAME synchronous step.
   * That indivisibility is the whole guard: an `await` between reading the tail and appending to it
   * lets two callers that both observed the old tail each start a run, and then two `runOnce` bodies
   * spawn duplicate `herdr`/`claude` probes, race each other's `publish`, and clobber one another's
   * `lastError`. Awaiting `inFlight` and only then starting had exactly that window — two Rechecks
   * landing on one in-flight run both resumed past their await and both started.
   *
   * The tail is cleared only by the link that still OWNS it: an orphaned link settling must not null a
   * field that now points at a later run, which would re-open the same window for a third caller.
   *
   * Chaining with `.then` is safe only because `runOnce` is total — a rejecting body would poison the
   * tail and every run queued behind it would be skipped.
   */
  const chain = (body: () => Promise<void>): Promise<void> => {
    const link: Promise<void> = (inFlight ?? Promise.resolve()).then(body).finally(() => {
      if (inFlight === link) inFlight = null;
    });
    inFlight = link;
    return link;
  };

  // Timer path: collapse onto whatever is already running rather than queueing behind it. Cheap, and
  // the next tick is 60 s away.
  const tick = (): Promise<void> => inFlight ?? chain(() => runOnce(false));

  // Recheck path: always queue a run of its own, behind anything already in flight, with the version
  // TTL bypassed — so the answer it returns post-dates the request instead of predating it.
  const refresh = (): Promise<void> => chain(() => runOnce(true));

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

/**
 * The update check with its network and its disk taken away. `enumerateChecks` runs on every
 * `npm run check` and every CI run, so a producer that reached api.github.com from here would make
 * offline development wait out the deadline and spend the shared hourly budget from CI's own IP.
 */
const INERT_UPDATE_IO: UpdateCheckIo = {
  enabled: false,
  version: null,
  repoSlug: () => null,
  fetch: () => { throw new Error("enumerateChecks must never perform a request"); },
  cache: { read: () => null, write: () => undefined, degraded: () => null },
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
  const remoteEnv = ENUMERATE_ENVS.find((e) => e.kind === "remote");
  const remoteRows = remoteEnv === undefined ? [] : await composeRemoteRows({
    env: remoteEnv, probe: null, reason: "enumeration — no probe",
    repoRoot: "/repo", nodeVersion: "0.0.0", now: () => 0, localHash: () => null, ccVersion: null,
  });
  const update = await updateCheck(INERT_UPDATE_IO, () => 0);
  return suppressUnrunnable(
    [...cheap, ...versions, ...remoteRows, update.check], unreachableIds(ENUMERATE_ENVS, snapshot), 0,
  );
}
