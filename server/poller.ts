import type { AttentionMap, EnvState, RecapStatus, SessionRow, Snapshot, StatuslineData, StatuslineStatus } from "@shared/schema";

import { ATTENTION_MIN_WORK_MS, CHEAP_INTERVAL_MS, RECAP_ENABLED, RECAP_INTERVAL_MS, STATUSLINE_ENABLED, SWEEP_INITIAL_DELAY_MS, TAB_RENAME_ENABLED } from "../config.ts";
import type { HerdrEnv } from "../environments.ts";
import type { AttentionStore } from "./attention-store.ts";
import { listSessions, tabRename as tabRenameHerdr } from "./herdr.ts";
import { createRecapCache, type RecapCache } from "./recap.ts";
import { guardedInterval, makeGuarded } from "./scheduler.ts";
import { createStatuslineCache, type StatuslineCache } from "./statusline-cache.ts";
import { readStatusline } from "./statusline.ts";
import { computeRenames } from "./tab-namer.ts";
import { readRecap } from "./transcript.ts";
import { detectTransitions, type WorkingMap } from "./transition.ts";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (): void => {};

export type ListFn = (env: HerdrEnv) => Promise<SessionRow[]>;
export type RecapFn = (env: HerdrEnv, sessionId: string) => Promise<{ recap: string | null; status: RecapStatus }>;
export type StatuslineFn = (env: HerdrEnv, sessionId: string) => Promise<{ data: StatuslineData | null; status: StatuslineStatus }>;

export interface Poller {
  getSnapshot(): Snapshot;
  getAttention(): AttentionMap;
  onSnapshot(cb: (s: Snapshot) => void): () => void;
  pollOnce(): Promise<void>;
  runClaudeSweepOnce(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createPoller(opts: {
  envs: readonly HerdrEnv[];
  list?: ListFn;
  recap?: RecapFn;
  statusline?: StatuslineFn;
  intervalMs?: number;
  recapIntervalMs?: number;
  minWorkMs?: number;
  attention?: AttentionStore;
  tabRename?: (env: HerdrEnv, tabId: string, label: string) => Promise<void>;
  tabRenameEnabled?: boolean;
  initialSweepDelayMs?: number;
}): Poller {
  const list = opts.list ?? listSessions;
  const recapFn = opts.recap ?? readRecap;
  const statuslineFn = opts.statusline ?? readStatusline;
  const intervalMs = opts.intervalMs ?? CHEAP_INTERVAL_MS;
  const recapIntervalMs = opts.recapIntervalMs ?? RECAP_INTERVAL_MS;
  const minWorkMs = opts.minWorkMs ?? ATTENTION_MIN_WORK_MS;
  const attention = opts.attention;
  const tabRenameFn = opts.tabRename ?? tabRenameHerdr;
  const tabRenameEnabled = opts.tabRenameEnabled ?? TAB_RENAME_ENABLED;
  const initialSweepDelayMs = opts.initialSweepDelayMs ?? SWEEP_INITIAL_DELAY_MS;
  let working: WorkingMap = {};
  const polledEnvs = new Set<string>();
  const envStates: Record<string, EnvState> = {};
  const perEnv = new Map<string, SessionRow[]>();
  const recapCache: RecapCache = createRecapCache();
  const statuslineCache: StatuslineCache = createStatuslineCache();
  const warnedNoIntegration = new Set<string>();
  const subs = new Set<(s: Snapshot) => void>();
  let snapshot: Snapshot = { envs: {}, sessions: [] };

  function rebuild(): void {
    const sessions: SessionRow[] = [];
    for (const e of opts.envs) {
      for (const row of perEnv.get(e.id) ?? []) {
        const key = `${e.id}:${row.paneId}`;
        let merged: SessionRow = row;
        const rc = recapCache.get(key);
        if (rc !== null && row.sessionId !== null && rc.sessionId === row.sessionId) {
          merged = { ...merged, recap: rc.recap, recapAt: rc.at, recapStatus: rc.status };
        } else if (row.sessionId === null) {
          merged = { ...merged, recapStatus: "no-session-ref" };
        }
        const sc = statuslineCache.get(key);
        if (sc !== null && row.sessionId !== null && sc.sessionId === row.sessionId) {
          merged = { ...merged, statusline: sc.data, statuslineStatus: sc.status };
        } else if (row.sessionId === null) {
          merged = { ...merged, statuslineStatus: "no-session-ref" };
        }
        sessions.push(merged);
      }
    }
    // Shallow-copy envStates so a previously emitted snapshot is not retroactively mutated by a
    // later poll (the sessions array is already freshly allocated each rebuild).
    snapshot = { envs: { ...envStates }, sessions };
  }

  async function pollEnv(env: HerdrEnv): Promise<void> {
    try {
      const prev = perEnv.get(env.id) ?? [];
      const curr = await list(env);
      perEnv.set(env.id, curr);
      envStates[env.id] = { reachable: true, kind: env.kind, label: env.label };
      if (attention !== undefined) {
        const now = Date.now();
        const { events, working: nextWorking, clearedKeys } = detectTransitions(prev, curr, working, now, minWorkMs);
        working = nextWorking;
        attention.apply(env, events, clearedKeys); // sync insert/delete before rebuild+push
        if (!polledEnvs.has(env.id)) {
          polledEnvs.add(env.id);
          attention.pruneEnv(env, new Set(curr.map((r) => `${env.id}:${r.paneId}`)));
        }
      }
    } catch (err) {
      envStates[env.id] = { reachable: false, error: err instanceof Error ? err.message : String(err), kind: env.kind, label: env.label };
    }
    rebuild();
    for (const cb of subs) cb(snapshot);
  }

  async function claudeSweep(): Promise<void> {
    // Collect live pane keys from all reachable envs (for pruning)
    const liveKeys = new Set<string>();
    for (const env of opts.envs) {
      if (envStates[env.id]?.reachable !== true) continue;
      for (const row of perEnv.get(env.id) ?? []) {
        liveKeys.add(`${env.id}:${row.paneId}`);
      }
    }

    await Promise.all(opts.envs.map(async (env) => {
      if (envStates[env.id]?.reachable !== true) return;
      const rows = perEnv.get(env.id) ?? [];
      const t0 = Date.now();
      let found = 0, notFound = 0, noSummary = 0, errors = 0;

      // Install-drift heuristic: warn once if panes have cwd but no sessionId
      const noSessionCount = rows.filter((r) => r.sessionId === null && r.cwd !== "").length;
      if (noSessionCount > 0 && !warnedNoIntegration.has(env.id)) {
        warnedNoIntegration.add(env.id);
        console.warn(`[recap] integration likely not installed for env "${env.id}": ${String(noSessionCount)} pane(s) have no sessionId — run: herdr integration install claude`);
      }

      for (const row of rows) {
        if (row.sessionId === null) continue;
        const key = `${env.id}:${row.paneId}`;
        if (RECAP_ENABLED) {
          try {
            const { recap, status } = await recapFn(env, row.sessionId);
            recapCache.update(key, row.sessionId, recap, status);
            if (status === "ok") found++;
            else if (status === "not-found") notFound++;
            else if (status === "no-summary") noSummary++;
            else errors++;
          } catch (err) {
            errors++;
            console.warn(`[recap] read error: env=${env.id} pane=${row.paneId} err=${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (STATUSLINE_ENABLED) {
          try {
            const { data, status } = await statuslineFn(env, row.sessionId);
            statuslineCache.update(key, row.sessionId, data, status);
          } catch (err) {
            console.warn(`[statusline] read error: env=${env.id} pane=${row.paneId} err=${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // Rename herdr tabs to their Claude session name (user-set names only). Best-effort: a failed
      // rename is logged and never breaks the sweep. Idempotent — once renamed, label == name → no-op.
      // Convergence note: idempotency compares against `rows[].tab`, which is refreshed by pollEnv
      // (CHEAP_INTERVAL_MS), NOT by this sweep. It relies on CHEAP_INTERVAL_MS < RECAP_INTERVAL_MS so
      // the label is fresh by the next sweep; if that ordering is inverted (or herdr stores the label
      // non-verbatim) a rename re-fires each sweep — a redundant same-value SSH call, never incorrect.
      if (tabRenameEnabled && STATUSLINE_ENABLED) {
        const renames = computeRenames(rows, (r) => statuslineCache.get(`${env.id}:${r.paneId}`)?.data ?? null);
        for (const op of renames) {
          try {
            await tabRenameFn(env, op.tabId, op.label);
          } catch (err) {
            console.warn(`[tab-rename] env=${env.id} tab=${op.tabId} err=${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // Only surface the sweep summary when something went wrong. A clean sweep runs on every
      // recap interval, so logging it unconditionally floods the logs with uninteresting JSON.
      if (errors > 0) {
        console.warn(JSON.stringify({
          event: "recap_sweep", env: env.id,
          panes_with_session_id: rows.filter((r) => r.sessionId !== null).length,
          found, not_found: notFound, no_summary: noSummary, errors,
          ms: Date.now() - t0,
        }));
      }
    }));

    recapCache.prune(liveKeys);
    statuslineCache.prune(liveKeys);
    rebuild();
    for (const cb of subs) cb(snapshot);
  }

  let stops: (() => void)[] = [];
  let started = false;
  return {
    getSnapshot: () => snapshot,
    getAttention: () => attention?.getMap() ?? {},
    onSnapshot(cb) { subs.add(cb); return () => { subs.delete(cb); }; },
    async pollOnce() {
      // Enforced invariant: start() owns the guarded loops; a manual pollOnce() afterwards would
      // race them and produce out-of-order snapshots. Used by tests and by an optional cold-start
      // before start(), never after.
      if (started) throw new Error("pollOnce() must not be called after start()");
      for (const e of opts.envs) await pollEnv(e);
    },
    runClaudeSweepOnce: () => claudeSweep(),
    start() {
      started = true;
      const listStops = opts.envs.map((e) => guardedInterval(() => pollEnv(e), intervalMs));
      let sweepStop = noop;
      if (RECAP_ENABLED || STATUSLINE_ENABLED) {
        // One shared guard across the immediate kick, the delayed kick, and the interval so they never
        // overlap. The immediate kick preserves the "sweep runs on start" contract (used when perEnv is
        // pre-populated, e.g. a cold-start pollOnce or tests) but is a no-op on a real cold start, where
        // perEnv is still empty until the first poll lands — hence the delayed kick after
        // initialSweepDelayMs (by which point the poll has populated perEnv) makes the first REAL sweep
        // prompt instead of a full recap interval away.
        const sweep = makeGuarded(claudeSweep);
        void sweep();
        const intervalId = setInterval(() => void sweep(), recapIntervalMs);
        const kickId = setTimeout(() => void sweep(), initialSweepDelayMs);
        sweepStop = () => { clearInterval(intervalId); clearTimeout(kickId); };
      }
      stops = [...listStops, sweepStop];
    },
    stop() { for (const s of stops) s(); stops = []; started = false; },
  };
}
