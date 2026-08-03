import type { Board } from "@shared/board-schema";
import type { Snapshot } from "@shared/schema";

import type { HerdrEnv } from "../environments.ts";
import { buildLiveIndex, resolveLiveRow } from "./live-resolve.ts";

export interface ReapCandidateLink {
  readonly env: string;
  readonly paneId: string;
  readonly tabId: string;
  readonly tabLabel: string;
  readonly workspaceId: string;
}

export interface TabInfo {
  readonly tabId: string;
  readonly label: string;
  readonly workspaceId: string;
}

export interface DetectInput {
  readonly detached: readonly ReapCandidateLink[];
  readonly tabsByEnv: ReadonlyMap<string, readonly TabInfo[]>;
  readonly now: number;
  readonly since: ReadonlyMap<string, number>;
  readonly graceMs: number;
}

export interface ReapDecision {
  readonly env: string;
  readonly paneId: string;
  readonly tabId: string;
  /** First sighting as detached — lets the reap log say how long the tab lingered. */
  readonly firstSeenAt: number;
}

export interface DetectOutput {
  readonly reap: readonly ReapDecision[];
  readonly since: Map<string, number>;
}

export function detectZombies(input: DetectInput): DetectOutput {
  const { detached, tabsByEnv, now, since, graceMs } = input;
  const nextSince = new Map<string, number>();
  const reap: ReapDecision[] = [];
  for (const link of detached) {
    if (link.tabId === "") continue;
    // Guard on the STABLE coordinates (workspaceId + tabId): the stored tab must still exist. A herdr
    // restart reassigns ids, so a missing tab — or a same-id tab in a different workspace — is not ours;
    // skip it (and don't seed a timer) so churn is never mistaken for an exited Claude. We deliberately
    // do NOT compare the label: corral renames herdr tabs to the Claude session name, so link.tabLabel
    // goes stale — comparing it would leave every renamed session's zombie tab uncollected.
    const tabs = tabsByEnv.get(link.env) ?? [];
    const matches = tabs.some((t) => t.tabId === link.tabId && t.workspaceId === link.workspaceId);
    if (!matches) continue;
    const key = `${link.env}:${link.tabId}`;
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

export interface ZombieReaperOpts {
  readonly poller: ReaperPoller;
  readonly storage: ReaperStorage;
  readonly envs: readonly HerdrEnv[];
  readonly listTabs: (env: HerdrEnv) => Promise<{ tab_id: string; label: string; workspace_id: string }[]>;
  readonly closePane: (env: HerdrEnv, paneId: string) => Promise<void>;
  readonly now?: () => number;
  /** Required: forces every caller through resolveReapGrace, so the clamp cannot be bypassed. */
  readonly graceMs: number;
}

// Subscribe to poller snapshots and reap zombie tabs (a detached link whose herdr tab still lingers,
// agentless, because Claude exited). Detection reuses the read-path liveness resolver, so it can never
// diverge from what the board shows. herdr is only ever MUTATED here (the poller is otherwise
// read-only), and only via `pane close`, which cascades tab → workspace. Two safety rails: an
// unreachable env is skipped entirely (a herdr restart flips every link detached at once — we must not
// reap then), and detectZombies' workspaceId+tabId guard rejects a reassigned id. `since` (the
// per-tab grace clock) is retained across snapshots; an in-flight guard serializes overlapping polls.
export function startZombieReaper(opts: ZombieReaperOpts): () => void {
  const now = opts.now ?? ((): number => Date.now());
  const graceMs = opts.graceMs;
  let since = new Map<string, number>();
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
      for (const board of opts.storage.getAllBoards()) {
        for (const task of board.tasks) {
          for (const link of task.sessions) {
            if (link.tabId === "" || resolveLiveRow(link, index) !== undefined) continue;
            // A genuine zombie has NO agent at its pane (Claude exited, herdr dropped the agent). If a
            // live agent occupies link.paneId, the pane was reused by a DIFFERENT session (e.g. the user
            // re-ran `claude` in the lingering shell) — resolveLiveRow still reports our link detached,
            // but reaping would kill that session. Skip it, mirroring the /close route's pane_reused guard.
            if (index.liveMap.has(`${link.env}:${link.paneId}`)) continue;
            const arr = byEnv.get(link.env) ?? [];
            arr.push({
              env: link.env, paneId: link.paneId, tabId: link.tabId,
              tabLabel: link.tabLabel, workspaceId: link.workspaceId,
            });
            byEnv.set(link.env, arr);
          }
        }
      }
      if (byEnv.size === 0) { since = new Map(); return; }

      // Fetch the live tab list ONLY for reachable envs with detached candidates. Skipping unreachable
      // envs is the churn rail: their tabs are unknown, so nothing there is ever reaped.
      const tabsByEnv = new Map<string, TabInfo[]>();
      await Promise.all([...byEnv.keys()].map(async (envId) => {
        if (snapshot.envs[envId]?.reachable !== true) return;
        const env = opts.envs.find((e) => e.id === envId);
        if (env === undefined) return;
        try {
          const tabs = await opts.listTabs(env);
          tabsByEnv.set(envId, tabs.map((t) => ({ tabId: t.tab_id, label: t.label, workspaceId: t.workspace_id })));
        } catch { /* a failed list just means no reap for this env this round */ }
      }));

      const detached = [...byEnv.values()].flat();
      const result = detectZombies({ detached, tabsByEnv, now: now(), since, graceMs });
      since = result.since;

      // Re-read liveness: a poll may have landed during the (possibly slow, remote-SSH) listTabs await
      // and put a session in the pane. Covers only that await window — staleness is the grace's job.
      const fresh = buildLiveIndex(opts.poller.getSnapshot().sessions);
      await Promise.all(result.reap.map(async (r) => {
        const env = opts.envs.find((e) => e.id === r.env);
        if (env === undefined) return;
        if (fresh.liveMap.has(`${r.env}:${r.paneId}`)) return;
        try {
          await opts.closePane(env, r.paneId);
          console.warn(JSON.stringify({
            event: "zombie_reaped", env: r.env, pane: r.paneId, tab: r.tabId,
            detached_for_ms: now() - r.firstSeenAt, grace_ms: graceMs,
          }));
        } catch (err) {
          console.warn(`[zombie-reaper] pane close failed env=${r.env} pane=${r.paneId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }));
    } finally {
      inFlight = false;
    }
  }

  return opts.poller.onSnapshot(() => { void tick(); });
}
