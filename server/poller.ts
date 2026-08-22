import type { AttentionMap, EnvState, RecapSource, RecapStatus, RegistryStatus, SessionRow, Snapshot, StatuslineData, StatuslineStatus } from "@shared/schema";

import { ATTENTION_MIN_WORK_MS, CHEAP_INTERVAL_MS, CLAUDE_REGISTRY_POLL_MS, RECAP_ENABLED, RECAP_INTERVAL_MS, STATUSLINE_ENABLED, SWEEP_INITIAL_DELAY_MS, TAB_RENAME_ENABLED } from "../config.ts";
import type { HerdrEnv } from "../environments.ts";
import type { AttentionStore } from "./attention-store.ts";
import { listSessions, tabRename as tabRenameHerdr } from "./herdr.ts";
import { createRecapCache, type RecapCache } from "./recap.ts";
import { makeGuarded, runGuarded } from "./scheduler.ts";
import {
  pickLatest, readRegistry as readRegistryDefault, type RegistryRead, type RegistryRecord,
  remoteControlOf, claudeNameOf, claudeNameUserSetOf,
} from "./session-registry.ts";
import { createStatuslineCache, type StatuslineCache } from "./statusline-cache.ts";
import { readStatusline } from "./statusline.ts";
import { computeRenames } from "./tab-namer.ts";
import { readRecap } from "./transcript.ts";
import { detectTransitions, type WorkingMap } from "./transition.ts";

/**
 * Shallow field compare over every field RegistryRecordSchema declares. It exists so an unchanged read
 * does not broadcast — the property that makes a short interval affordable — so it must compare
 * CONTENT, not identity: every tick produces freshly-parsed objects, so `prev.record !== next` always.
 *
 * NOT `JSON.stringify`: key order is not guaranteed across reads of a rewritten file, and two identical
 * records serialised in different orders would compare unequal and broadcast every tick.
 *
 * `?? null` on every optional: the registry writes a literal `null` on disconnect but omits the key
 * before the first connect, so `undefined` and `null` are the same state here and must not compare
 * unequal — otherwise the first read after a session's very first RC connect broadcasts twice.
 *
 * Module scope and exported so the field list can be tested by BEHAVIOUR against the schema. It was a
 * closure by placement, not by need — it captures nothing — and a source-text assertion over the
 * comparison chain is satisfied by a commented-out line, which is not a test.
 */
export function recordsEqual(a: RegistryRecord | null, b: RegistryRecord | null): boolean {
  if (a === null || b === null) return a === b;
  return a.sessionId === b.sessionId
    && (a.name ?? null) === (b.name ?? null)
    && (a.nameSource ?? null) === (b.nameSource ?? null)
    && (a.status ?? null) === (b.status ?? null)
    && (a.waitingFor ?? null) === (b.waitingFor ?? null)
    && (a.bridgeSessionId ?? null) === (b.bridgeSessionId ?? null)
    && (a.updatedAt ?? null) === (b.updatedAt ?? null);
}

export type ListFn = (env: HerdrEnv) => Promise<SessionRow[]>;
export type RecapFn = (env: HerdrEnv, sessionId: string) => Promise<{ recap: string | null; status: RecapStatus; source: RecapSource | null }>;
export type StatuslineFn = (env: HerdrEnv, sessionId: string) => Promise<{ data: StatuslineData | null; status: StatuslineStatus }>;

export interface Poller {
  getSnapshot(): Snapshot;
  getAttention(): AttentionMap;
  onSnapshot(cb: (s: Snapshot) => void): () => void;
  pollOnce(): Promise<void>;
  /**
   * Re-poll ONE environment now, off the interval. Shares that environment's interval guard, so a
   * refresh that lands mid-tick collapses into the tick already running instead of racing it.
   * Exists for the identity path: a pane created seconds ago is not in the snapshot until the next
   * cheap poll (30s by default), and `GET /api/whoami` cannot answer "which session am I" from a
   * snapshot that predates the caller's own pane. Unknown env id resolves without polling.
   */
  refreshEnv(envId: string): Promise<void>;
  /**
   * Patch rows from a freshly-read registry and push the result, off the poll cadence. Called by the
   * local interval and by the remote sweep — the two writers, one per environment kind. Records whose
   * sessionId matches no known row are dropped: binding a session id to a pane needs herdr, and the
   * next poll does that.
   *
   * Takes the WHOLE `RegistryRead`, not just its records: `status` and `truncated` decide whether an
   * empty result means "this session is gone" or "we could not look".
   */
  applyRegistry(env: HerdrEnv, read: RegistryRead): void;
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
  readRegistry?: (env: HerdrEnv) => Promise<RegistryRead>;
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
  const readRegistryFn = opts.readRegistry ?? readRegistryDefault;
  let working: WorkingMap = {};
  const polledEnvs = new Set<string>();
  const envStates: Record<string, EnvState> = {};
  const perEnv = new Map<string, SessionRow[]>();
  const recapCache: RecapCache = createRecapCache();
  const statuslineCache: StatuslineCache = createStatuslineCache();
  const warnedNoIntegration = new Set<string>();
  // Keyed by pane key, carrying the sessionId it was captured for so a recycled pane never inherits
  // the previous session's state — the same guard recapCache and statuslineCache use. `record: null`
  // means "we looked and this session was not there", which `status` then explains.
  const registryCache = new Map<string, { sessionId: string; record: RegistryRecord | null; status: RegistryStatus }>();
  // One warning each per environment per process — both mirror `warnedNoIntegration` above. The sweep
  // and the interval between them touch every environment forever, so a permanent condition logged on
  // every pass is a log flood that trains the operator to ignore the file.
  const warnedTruncated = new Set<string>();
  const warnedDegraded = new Set<string>();
  // Per environment: did the LAST sweep read any `away_summary` recap? Logged only on a transition, so
  // the operator learns when the top rung dies or comes back without a line every sweep. Absent = not
  // swept yet, which is why the value is a boolean and the map's absence is the third state.
  const awayRungAlive = new Map<string, boolean>();
  const subs = new Set<(s: Snapshot) => void>();
  let snapshot: Snapshot = { envs: {}, sessions: [] };

  /**
   * A PLAIN SET. There is no precedence rule here and there must not be one: each environment has
   * exactly one writer and every read is a full directory read, so a later read simply supersedes an
   * earlier one and absence is authoritative.
   *
   * Do NOT reintroduce an `updatedAt` comparison "for safety". The bridge-state setter writes
   * bridgeSessionId WITHOUT stamping updatedAt, so a Remote Control transition arrives with an EQUAL
   * updatedAt — any `>=` guard would silently freeze the RC badge in both directions with no test
   * failing. The equal-updatedAt case is pinned by a test.
   *
   * `pickLatest` still resolves duplicate sessionIds WITHIN one read. Different question.
   *
   * Returns whether anything changed, so applyRegistry does not broadcast a whole snapshot to every
   * SSE subscriber for a write that changed nothing.
   */
  function writeRegistry(
    key: string,
    sessionId: string,
    // `null` = a successful read that did not contain this session → clear it.
    // `undefined` = a FAILED read → keep whatever record is cached, change only the status.
    record: RegistryRecord | null | undefined,
    status: RegistryStatus,
  ): boolean {
    const prev = registryCache.get(key);
    const next = record === undefined ? (prev?.sessionId === sessionId ? prev.record : null) : record;
    if (prev?.sessionId === sessionId
        && prev.status === status && recordsEqual(prev.record, next)) {
      return false;
    }
    registryCache.set(key, { sessionId, record: next, status });
    return true;
  }

  function rebuild(): void {
    const sessions: SessionRow[] = [];
    for (const e of opts.envs) {
      for (const row of perEnv.get(e.id) ?? []) {
        const key = `${e.id}:${row.paneId}`;
        let merged: SessionRow = row;
        const rc = recapCache.get(key);
        if (rc !== null && row.sessionId !== null && rc.sessionId === row.sessionId) {
          merged = { ...merged, recap: rc.recap, recapAt: rc.at, recapStatus: rc.status, recapSource: rc.source };
        } else if (row.sessionId === null) {
          // recap/recapSource are left as the row has them (null from every producer) — mirroring the
          // statusline branch below, which also sets only its status.
          merged = { ...merged, recapStatus: "no-session-ref" };
        }
        const sc = statuslineCache.get(key);
        if (sc !== null && row.sessionId !== null && sc.sessionId === row.sessionId) {
          merged = { ...merged, statusline: sc.data, statuslineStatus: sc.status };
        } else if (row.sessionId === null) {
          merged = { ...merged, statuslineStatus: "no-session-ref" };
        }
        if (row.sessionId === null) {
          merged = { ...merged, registryStatus: "no-session-ref" };
        } else {
          const reg = registryCache.get(key);
          if (reg?.sessionId === row.sessionId) {
            merged = reg.record === null
              ? { ...merged, registryStatus: reg.status }
              : {
                  ...merged,
                  claudeStatus: reg.record.status ?? null,
                  waitingFor: reg.record.waitingFor ?? null,
                  remoteControl: remoteControlOf(reg.record),
                  // `reg.status`, NOT the literal "ok". A failed read deliberately KEEPS the last good
                  // record and records the failure alongside it, so this branch is reached with status
                  // "read-error" — and hard-coding "ok" here would report a stale row as healthy, which
                  // is the one thing registryStatus exists to prevent. For a good read `reg.status`
                  // already is "ok".
                  registryStatus: reg.status,
                  claudeName: claudeNameOf(reg.record),
                  claudeNameUserSet: claudeNameUserSetOf(reg.record),
                };
          }
          // A row whose pane has no cache entry keeps `registryStatus: null` — "nothing has read this
          // pane yet", distinct from every other case, and why the enum has six members.
        }
        sessions.push(merged);
      }
    }
    // Rebuilt in `opts.envs` order, NOT spread from `envStates` — the polls run concurrently, so
    // insertion order there is "who answered first", and `Object.keys(envs)` feeds the UI's env
    // dropdown (and its default selection). A fresh record per rebuild also keeps a previously
    // emitted snapshot from being retroactively mutated by a later poll (the sessions array is
    // already freshly allocated each rebuild). Unpolled envs stay absent, as before.
    const envs: Record<string, EnvState> = {};
    for (const e of opts.envs) {
      const state = envStates[e.id];
      if (state !== undefined) envs[e.id] = state;
    }
    snapshot = { envs, sessions };
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

  // Declared in the body, not on the returned object literal — both callers (claudeSweep, and the
  // local interval in start()) call it as a bare name from inside this scope.
  //
  // The parameter is `read`, a whole RegistryRead — NOT `records`: `status` and `truncated` are what
  // separate "this session is gone" from "we could not look".
  function applyRegistry(env: HerdrEnv, read: RegistryRead): void {
    const rows = perEnv.get(env.id) ?? [];
    const latest = pickLatest(read.records);
    let changed = false;

    // Health, logged ONCE PER ENVIRONMENT PER PROCESS — the same shape as the no-integration warning
    // in claudeSweep, and here rather than in either caller so BOTH writers report. not-found,
    // bad-schema and read-error all render the identical "state unavailable" on the board, so without
    // this the operator can see THAT corral cannot read the registry but never WHY. `bad-schema` above
    // all: it is the drift detector for an undocumented format on an auto-updating CLI, and a detector
    // nothing reports is not a detector.
    if (read.status !== "ok" && read.status !== "no-config-dirs" && !warnedDegraded.has(env.id)) {
      warnedDegraded.add(env.id);
      console.warn(`[registry] env "${env.id}": registry read degraded (${read.status}) — affected sessions show "state unavailable" on the board. "bad-schema" means Claude's session-registry format changed and corral needs updating; "read-error" is a permissions or transport failure; "not-found" means the configured claudeConfigDirs hold no sessions directory. (Logged once per environment.)`);
    }
    // `no-config-dirs` is deliberately NOT logged: it is the DEFAULT for every remote environment, so
    // it would warn once per process on a completely healthy fleet. Preflight names it at startup
    // instead, which is the surface an operator fixes it from.
    if (read.truncated && !warnedTruncated.has(env.id)) {
      warnedTruncated.add(env.id);
      console.warn(`[registry] env "${env.id}": the read hit CLAUDE_REGISTRY_MAX_FILES/CLAUDE_REGISTRY_MAX_BYTES and was truncated — some sessions may show no state. Registry files for dead sessions are never cleaned up, so the count grows for the life of the machine; raise CLAUDE_REGISTRY_MAX_FILES or clear the directory. (Logged once per environment.)`);
    }

    for (const row of rows) {
      if (row.sessionId === null) continue;
      const key = `${env.id}:${row.paneId}`;
      const record = latest.get(row.sessionId) ?? null;
      if (read.status !== "ok") {
        // A FAILED read is not an empty one. Record the failure on the row and leave whatever the last
        // good read produced — a momentary EACCES must not blank the board, and it must not be
        // reported as "this session is gone" either.
        if (writeRegistry(key, row.sessionId, undefined, read.status)) changed = true;
        continue;
      }
      // Absence IS authoritative: every reader does a full directory read, so a session missing from
      // the read is genuinely gone and its record is cleared.
      if (writeRegistry(key, row.sessionId, record, record === null ? "not-found" : "ok")) changed = true;
    }
    // No broadcast when nothing changed. `rebuild()` reconstructs the whole session array and every
    // SSE subscriber receives the entire snapshot, not a delta — so an unchanged tick that pushed
    // anyway would cost the size of the board rather than the size of the change.
    if (!changed) return;
    // Without this the record lands in a cache with no path out — SSE frames come only from these
    // subscribers, so the interval would buy nothing at all.
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
      // Counted per ladder rung, not just `found`. The ladder fills the recap line for nearly every
      // session, which means it also HIDES whether the top rung still works: `away_summary` is refused
      // outright while the account's rate-limit status is not exactly `allowed` (docs/adr/0005), and
      // every line would still read fine throughout. `away_summary: 0` sweep after sweep is the signal
      // that the top rung is shut — and the day it reopens is a log line only if this is counted.
      const bySource = new Map<RecapSource, number>();

      // Install-drift heuristic: warn once if panes have cwd but no sessionId. State the OBSERVATION
      // and both causes, never a single asserted cause. A missing integration is only one of them:
      // herdr's hook exits 0 without reporting a session unless HERDR_ENV, HERDR_SOCKET_PATH and
      // HERDR_PANE_ID are all set in that pane, so any pane not started inside a herdr context trips
      // this permanently. The old message asserted "integration likely not installed" and prescribed
      // the install command — which changes nothing where the integration is already there, sending
      // the operator down a dead end while the real cause goes unmentioned.
      const noSessionCount = rows.filter((r) => r.sessionId === null && r.cwd !== "").length;
      if (noSessionCount > 0 && !warnedNoIntegration.has(env.id)) {
        warnedNoIntegration.add(env.id);
        console.warn(`[recap] env "${env.id}": ${String(noSessionCount)} pane(s) report no Claude session id, so recap and live metrics stay empty for them. Either herdr's Claude integration is not installed on that machine (run: herdr integration install claude), or those panes were not started inside a herdr context — the hook reports nothing unless HERDR_ENV, HERDR_SOCKET_PATH and HERDR_PANE_ID are all set in the pane.`);
      }

      // REMOTE environments only: the local interval already covers local ones with the same reader,
      // and a second full read every 60 s would be duplicated work with no new information — and,
      // worse, a SECOND WRITER for one environment, which is the property absence-is-authoritative
      // rests on. ONE round trip per config directory, against the per-session statusline read below,
      // which is one per session.
      if (env.kind === "remote") {
        try {
          applyRegistry(env, await readRegistryFn(env));
        } catch (err) {
          console.warn(`[registry] read threw: env=${env.id} err=${err instanceof Error ? err.message : String(err)}`);
        }
      }

      for (const row of rows) {
        if (row.sessionId === null) continue;
        const key = `${env.id}:${row.paneId}`;
        if (RECAP_ENABLED) {
          try {
            const { recap, status, source } = await recapFn(env, row.sessionId);
            recapCache.update(key, row.sessionId, recap, status, source);
            if (source !== null) bySource.set(source, (bySource.get(source) ?? 0) + 1);
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
      //
      // The name comes from the REGISTRY, not the statusline: the capture is written only when Claude
      // renders its statusline, so an idle session's file goes stale and keeps the pre-rename name —
      // which made `/rename` invisible here. Hence no STATUSLINE_ENABLED half to this gate any more.
      // `rows` come from `perEnv` and carry no claudeName (that is merged later, in rebuild), so the
      // accessor reads registryCache directly, repeating rebuild's sessionId guard so a recycled pane
      // never inherits the previous session's name.
      if (tabRenameEnabled) {
        const renames = computeRenames(rows, (r) => {
          const reg = registryCache.get(`${env.id}:${r.paneId}`);
          if (r.sessionId === null || reg?.sessionId !== r.sessionId || reg.record === null) {
            return { name: null, userSet: false };
          }
          return { name: claudeNameOf(reg.record), userSet: claudeNameUserSetOf(reg.record) };
        });
        for (const op of renames) {
          try {
            await tabRenameFn(env, op.tabId, op.label);
          } catch (err) {
            console.warn(`[tab-rename] env=${env.id} tab=${op.tabId} err=${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // Only surface the sweep summary when something went wrong, or when the top ladder rung changed
      // state. A clean sweep runs on every recap interval, so logging it unconditionally floods the logs
      // with uninteresting JSON — but a silently dead `away_summary` source is exactly what went
      // unnoticed for a month (docs/adr/0005), and the ladder now covers for it in the UI.
      const awayNow = (bySource.get("away-summary") ?? 0) > 0;
      const awayChanged = RECAP_ENABLED && rows.some((r) => r.sessionId !== null)
        && awayRungAlive.get(env.id) !== awayNow;
      if (awayChanged) awayRungAlive.set(env.id, awayNow);
      if (errors > 0 || awayChanged) {
        console.warn(JSON.stringify({
          event: "recap_sweep", env: env.id,
          panes_with_session_id: rows.filter((r) => r.sessionId !== null).length,
          found, not_found: notFound, no_summary: noSummary, errors,
          by_source: Object.fromEntries(bySource),
          ms: Date.now() - t0,
        }));
      }
    }));

    recapCache.prune(liveKeys);
    statuslineCache.prune(liveKeys);
    for (const k of [...registryCache.keys()]) if (!liveKeys.has(k)) registryCache.delete(k);
    rebuild();
    for (const cb of subs) cb(snapshot);
  }

  /**
   * Local freshness. Calls the SAME per-environment reader the sweep calls, so both paths do full
   * reads over all of an environment's config dirs — which is what makes absence authoritative and
   * removes any cross-writer precedence question. Local only: there is no cheap read over SSH, and
   * remote is the sweep's job, so this adds ZERO SSH round trips.
   *
   * Armed by start(), not by createPoller: a timer created at construction would tick in every test
   * and on every cold path that builds a poller without starting one, reading the real config dirs.
   *
   * Two local environments pointing at the same config dir read it twice per tick, once each. That is
   * correct rather than wasteful — they have different pane keys, and each needs a read authoritative
   * for its own rows. Deduplicating would reintroduce the per-directory bug this shape exists to
   * avoid: applyRegistry clears any session its read did not return, so a read covering one directory
   * out of several would clear the sessions living in the others, twice a tick, forever.
   */
  function startRegistryInterval(): () => void {
    const localEnvs = opts.envs.filter((e) => e.kind === "local");
    let tickRunning = false;
    const timer = setInterval(() => {
      // A tick still in flight skips this one. At ~1.8 ms per read against a multi-second interval
      // overlap is physically unreachable, but the guard is unconditional because the cost of being
      // wrong is two readers interleaving writes into one cache.
      if (tickRunning) return;
      tickRunning = true;
      void (async () => {
        try {
          for (const env of localEnvs) {
            // Per ENVIRONMENT, not per directory: applyRegistry clears any session the read did not
            // return, so it must be handed a read covering every one of that env's claudeConfigDirs.
            // readRegistry does; readRegistryDir(oneDir) does not.
            try {
              applyRegistry(env, await readRegistryFn(env));
            } catch (err) {
              // A read error is DATA — readRegistry reports it as a status and applyRegistry lands it
              // on the row. A throw is something else (a bug), and it must not kill the timer: an
              // unhandled rejection here would silently stop local state updating for the process's
              // whole life. Hence also the `finally` below.
              console.warn(`[registry] tick threw: env=${env.id} err=${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } finally {
          tickRunning = false;
        }
      })();
    }, CLAUDE_REGISTRY_POLL_MS);
    timer.unref();
    return () => { clearInterval(timer); };
  }

  let stops: (() => void)[] = [];
  let started = false;
  // One guard per environment, built once and shared by BOTH the interval below and refreshEnv —
  // see runGuarded's comment for why they must not each make their own.
  const envTicks = new Map<string, () => Promise<void>>(
    opts.envs.map((e) => [e.id, makeGuarded(() => pollEnv(e))]),
  );
  return {
    getSnapshot: () => snapshot,
    refreshEnv: async (envId) => { await envTicks.get(envId)?.(); },
    getAttention: () => attention?.getMap() ?? {},
    onSnapshot(cb) { subs.add(cb); return () => { subs.delete(cb); }; },
    async pollOnce() {
      // Enforced invariant: start() owns the guarded loops; a manual pollOnce() afterwards would
      // race them and produce out-of-order snapshots. Used by tests and by an optional cold-start
      // before start(), never after.
      if (started) throw new Error("pollOnce() must not be called after start()");
      for (const e of opts.envs) await pollEnv(e);
    },
    applyRegistry,
    runClaudeSweepOnce: () => claudeSweep(),
    start() {
      started = true;
      const listStops = opts.envs.map((e) => runGuarded(envTicks.get(e.id) ?? makeGuarded(() => pollEnv(e)), intervalMs));
      // The sweep ALWAYS runs — it used to be gated on RECAP_ENABLED || STATUSLINE_ENABLED, but the
      // registry read rides it and is the only backstop for remote environments and for the frozen-row
      // case, so with both captures off the backstop would not exist. Recap and statusline keep their
      // own guards inside the sweep, so turning a capture off still costs nothing.
      //
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
      const sweepStop = (): void => { clearInterval(intervalId); clearTimeout(kickId); };
      stops = [...listStops, sweepStop, startRegistryInterval()];
    },
    stop() { for (const s of stops) s(); stops = []; started = false; },
  };
}
