import type { Board } from "@shared/board-schema";
import type { Snapshot } from "@shared/schema";

import type { HerdrEnv } from "../environments.ts";
import type { PaneIdentity } from "./herdr.ts";
import { buildLiveIndex, resolveLiveRow } from "./live-resolve.ts";

export interface ReapCandidateLink {
  readonly env: string;
  readonly paneId: string;
  readonly tabId: string;
  readonly workspaceId: string;
}

export interface PaneInfo {
  readonly paneId: string;
  readonly tabId: string;
  readonly workspaceId: string;
  readonly hasAgent: boolean;
}

export interface DetectInput {
  readonly detached: readonly ReapCandidateLink[];
  readonly panesByEnv: ReadonlyMap<string, readonly PaneInfo[]>;
  readonly now: number;
  readonly since: ReadonlyMap<string, number>;
  readonly graceMs: number;
}

export interface ReapDecision {
  readonly env: string;
  readonly paneId: string;
  readonly tabId: string;
  /** First sighting as detached — lets the reap log say how long the pane lingered. */
  readonly firstSeenAt: number;
}

export interface DetectOutput {
  readonly reap: readonly ReapDecision[];
  readonly since: Map<string, number>;
}

/**
 * Pure decision: which detached candidates are safe to reap, given one `pane list` snapshot.
 *
 * NOT self-sufficient. `pane.hasAgent === false` here is not evidence of absence: a bash-style agent
 * (`herdr agent start <name> -- bash`) appears in `pane list` byte-identically to a free pane (see
 * `PaneIdentity.hasAgent` in server/herdr.ts). Safety depends entirely on the caller having already
 * dropped any link whose pane the poller's `agent list` index (`index.liveMap`) shows occupied —
 * this function has no way to reject a pane that index would have caught.
 */
export function detectZombies(input: DetectInput): DetectOutput {
  const { detached, panesByEnv, now, since, graceMs } = input;
  const nextSince = new Map<string, number>();
  const reap: ReapDecision[] = [];
  for (const link of detached) {
    // `AttachBodySchema` (server/api.ts) defaults an omitted tabId to "" — a link attached without one
    // is therefore permanently unreapable. Pre-existing and correct per ADR 0003: tab membership below
    // is a required identity guard and "" can never satisfy it, so this only short-circuits early.
    if (link.tabId === "") continue;
    // Verify the PANE we are about to close, not the tab. herdr allocates pane and tab numbers from
    // per-workspace counters that only move forward and are never returned to the pool (see ADR 0003),
    // so a pane missing from the list is gone permanently and a pane whose tab/workspace disagrees was
    // never ours. Either way: skip, seed no timer, issue no command. An agent on the pane means a live
    // session — ours or a stranger's — and is never a zombie.
    const pane = (panesByEnv.get(link.env) ?? []).find((p) => p.paneId === link.paneId);
    if (pane === undefined) continue;
    if (pane.tabId !== link.tabId || pane.workspaceId !== link.workspaceId) continue;
    if (pane.hasAgent) continue;
    const key = `${link.env}:${link.paneId}`;
    const first = since.get(key) ?? now;
    nextSince.set(key, first);
    if (now - first >= graceMs) {
      reap.push({ env: link.env, paneId: link.paneId, tabId: link.tabId, firstSeenAt: first });
    }
  }
  return { reap, since: nextSince };
}

interface ReaperPoller {
  getSnapshot(): Snapshot;
  onSnapshot(cb: (s: Snapshot) => void): () => void;
}
interface ReaperStorage {
  getAllBoards(): readonly Board[];
}

// Close attempts per pane per grace window. The pane precheck already makes a permanent
// `pane_not_found` loop unreachable — unless `pane list` and `pane close` ever disagree inside herdr,
// which this bounds regardless. Scoped to the grace window, never the process: three transient
// failures (a remote SSH timeout) must not strand a real zombie until restart, and a process-lifetime
// cap could also suppress a later pane that inherits the id after state loss.
const CLOSE_ATTEMPT_CAP = 3;

export interface ZombieReaperOpts {
  readonly poller: ReaperPoller;
  readonly storage: ReaperStorage;
  readonly envs: readonly HerdrEnv[];
  readonly listPanes: (env: HerdrEnv) => Promise<PaneIdentity[]>;
  readonly closePane: (env: HerdrEnv, paneId: string) => Promise<void>;
  readonly now?: () => number;
  /** Required: forces every caller through resolveReapGrace, so the clamp cannot be bypassed. */
  readonly graceMs: number;
}

// Subscribe to poller snapshots and reap zombie panes (a detached link whose herdr pane still lingers,
// agentless, because Claude exited). Detection reuses the read-path liveness resolver, so it can never
// diverge from what the board shows. herdr is only ever MUTATED here (the poller is otherwise
// read-only), and only via `pane close`, which cascades tab → workspace. Two safety rails: an
// unreachable env is skipped entirely (a herdr restart flips every link detached at once — we must not
// reap then), and detectZombies verifies the pane itself — existence, tab/workspace membership, and no
// agent — before any close. `since` (the grace clock) and `failures` (the close-attempt counter) are
// both keyed `env:paneId` and retained across snapshots; an in-flight guard serializes overlapping polls.
export function startZombieReaper(opts: ZombieReaperOpts): () => void {
  const now = opts.now ?? ((): number => Date.now());
  const graceMs = opts.graceMs;
  let since = new Map<string, number>();
  const failures = new Map<string, { window: number; count: number }>();
  // One warning per env per process for a failing `listPanes` — see the catch below.
  const warnedListFailures = new Set<string>();
  // Keeps `failures` bounded and window-scoped exactly like `since`: a key whose grace window ended
  // (candidate left detection) or restarted (re-seeded after a gap) no longer matches `since.get(key)`,
  // so its stale count is dropped rather than bleeding into a later, unrelated window.
  const pruneFailures = (): void => {
    for (const [key, f] of failures) {
      if (since.get(key) !== f.window) failures.delete(key);
    }
  };
  let lastTick: number | null = null;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      // A tick gap of a whole grace means ticks stopped (host suspend, blocked loop): every env's rows
      // predate the gap, so no poll could have refuted a pending timer. Re-seed instead of reaping.
      const t = now();
      if (lastTick !== null && t - lastTick > graceMs) since = new Map();
      lastTick = t;

      const snapshot = opts.poller.getSnapshot();
      const index = buildLiveIndex(snapshot.sessions);

      // Detached links (link.live would be null) that still carry a tabId, grouped by env.
      const byEnv = new Map<string, ReapCandidateLink[]>();
      // Several links can point at the same pane by design (api.ts's AttachBodySchema allows
      // re-attaching a task to a pane another link already holds). Without this, two detached links on
      // one pane become two ReapDecisions and two concurrent `closePane` calls — the loser gets
      // `pane_not_found` and books a spurious failure against a pane the winner already reaped.
      const seenPanes = new Set<string>();
      for (const board of opts.storage.getAllBoards()) {
        for (const task of board.tasks) {
          for (const link of task.sessions) {
            if (link.tabId === "" || resolveLiveRow(link, index) !== undefined) continue;
            // A genuine zombie has NO agent at its pane (Claude exited, herdr dropped the agent). If a
            // live agent occupies link.paneId, the pane was reused by a DIFFERENT session (e.g. the user
            // re-ran `claude` in the lingering shell) — resolveLiveRow still reports our link detached,
            // but reaping would kill that session. Skip it, mirroring the /close route's pane_reused guard.
            if (index.liveMap.has(`${link.env}:${link.paneId}`)) continue;
            const key = `${link.env}:${link.paneId}`;
            if (seenPanes.has(key)) continue;
            seenPanes.add(key);
            const arr = byEnv.get(link.env) ?? [];
            arr.push({ env: link.env, paneId: link.paneId, tabId: link.tabId, workspaceId: link.workspaceId });
            byEnv.set(link.env, arr);
          }
        }
      }
      if (byEnv.size === 0) { since = new Map(); pruneFailures(); return; }

      // Fetch the live pane list ONLY for reachable envs with detached candidates. Skipping unreachable
      // envs is the churn rail: their panes are unknown, so nothing there is ever reaped.
      const panesByEnv = new Map<string, PaneInfo[]>();
      await Promise.all([...byEnv.keys()].map(async (envId) => {
        if (snapshot.envs[envId]?.reachable !== true) return;
        const env = opts.envs.find((e) => e.id === envId);
        if (env === undefined) return;
        try {
          panesByEnv.set(envId, await opts.listPanes(env));
        } catch (err) {
          // With no entry in panesByEnv, detectZombies skips every candidate in THIS env and drops
          // their grace timers too (`panesByEnv.get(link.env) ?? []` reads as "pane gone"), so an env
          // whose list call flakes never accumulates grace — it re-seeds from zero once it recovers.
          // Rate-limited to once per env per process; this can fail every tick otherwise.
          if (!warnedListFailures.has(envId)) {
            warnedListFailures.add(envId);
            console.warn(`[zombie-reaper] pane list failed env=${envId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }));

      const detached = [...byEnv.values()].flat();
      const result = detectZombies({ detached, panesByEnv, now: now(), since, graceMs });
      since = result.since;
      pruneFailures();

      // Re-read liveness: a poll may have landed during the (possibly slow, remote-SSH) listPanes await
      // and put a session in the pane. Covers only that await window — staleness is the grace's job.
      const fresh = buildLiveIndex(opts.poller.getSnapshot().sessions);
      await Promise.all(result.reap.map(async (r) => {
        const env = opts.envs.find((e) => e.id === r.env);
        if (env === undefined) return;
        if (fresh.liveMap.has(`${r.env}:${r.paneId}`)) return;
        const key = `${r.env}:${r.paneId}`;
        try {
          await opts.closePane(env, r.paneId);
          failures.delete(key);
          console.warn(JSON.stringify({
            event: "zombie_reaped", env: r.env, pane: r.paneId, tab: r.tabId,
            detached_for_ms: now() - r.firstSeenAt, grace_ms: graceMs,
          }));
        } catch (err) {
          console.warn(`[zombie-reaper] pane close failed env=${r.env} pane=${r.paneId}: ${err instanceof Error ? err.message : String(err)}`);
          const prev = failures.get(key);
          const n = prev?.window === r.firstSeenAt ? prev.count + 1 : 1;
          if (n >= CLOSE_ATTEMPT_CAP) {
            // Give up for now, not for good: dropping the timer forces a full re-age before the next
            // attempt, so a pane herdr cannot close costs 3 log lines per grace window, not one per tick.
            failures.delete(key);
            since.delete(key);
          } else {
            failures.set(key, { window: r.firstSeenAt, count: n });
          }
        }
      }));
    } finally {
      inFlight = false;
    }
  }

  return opts.poller.onSnapshot(() => { void tick(); });
}
