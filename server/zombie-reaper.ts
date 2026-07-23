import type { Board } from "@shared/board-schema";
import type { Snapshot } from "@shared/schema";

import { ZOMBIE_REAP_GRACE_MS } from "../config.ts";
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

export interface DetectOutput {
  readonly reap: readonly { readonly env: string; readonly paneId: string }[];
  readonly since: Map<string, number>;
}

export function detectZombies(input: DetectInput): DetectOutput {
  const { detached, tabsByEnv, now, since, graceMs } = input;
  const nextSince = new Map<string, number>();
  const reap: { env: string; paneId: string }[] = [];
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
    if (now - first >= graceMs) reap.push({ env: link.env, paneId: link.paneId });
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
  readonly graceMs?: number;
}

// Subscribe to poller snapshots and reap zombie tabs (a detached link whose herdr tab still lingers,
// agentless, because Claude exited). Detection reuses the read-path liveness resolver, so it can never
// diverge from what the board shows. herdr is only ever MUTATED here (the poller is otherwise
// read-only), and only via `pane close`, which cascades tab → workspace. Two safety rails: an
// unreachable env is skipped entirely (a herdr restart flips every link detached at once — we must not
// reap then), and detectZombies' id+workspace+label guard rejects any reused id. `since` (the
// per-tab grace clock) is retained across snapshots; an in-flight guard serializes overlapping polls.
export function startZombieReaper(opts: ZombieReaperOpts): () => void {
  const now = opts.now ?? ((): number => Date.now());
  const graceMs = opts.graceMs ?? ZOMBIE_REAP_GRACE_MS;
  let since = new Map<string, number>();
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const snapshot = opts.poller.getSnapshot();
      const index = buildLiveIndex(snapshot.sessions);

      // Detached links (link.live would be null) that still carry a tabId, grouped by env.
      const byEnv = new Map<string, ReapCandidateLink[]>();
      for (const board of opts.storage.getAllBoards()) {
        for (const task of board.tasks) {
          for (const link of task.sessions) {
            if (link.tabId === "" || resolveLiveRow(link, index) !== undefined) continue;
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

      await Promise.all(result.reap.map(async (r) => {
        const env = opts.envs.find((e) => e.id === r.env);
        if (env === undefined) return;
        try {
          await opts.closePane(env, r.paneId);
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
