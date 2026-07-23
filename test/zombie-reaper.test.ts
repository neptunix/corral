import type { Board } from "@shared/board-schema";
import type { Snapshot } from "@shared/schema";
import { describe, expect, it } from "vitest";

import { getEnv } from "../environments.ts";
import { detectZombies, startZombieReaper, type ReapCandidateLink, type TabInfo } from "../server/zombie-reaper.ts";

const link = (over: Partial<ReapCandidateLink> = {}): ReapCandidateLink => ({
  env: "e", paneId: "w1:p2", tabId: "w1:t2", tabLabel: "task-a", workspaceId: "w1", ...over,
});
const tab = (over: Partial<TabInfo> = {}): TabInfo => ({
  tabId: "w1:t2", label: "task-a", workspaceId: "w1", ...over,
});
const tabsByEnv = (tabs: TabInfo[]): Map<string, TabInfo[]> => new Map([["e", tabs]]);

describe("detectZombies", () => {
  it("reaps a detached candidate whose tab still exists once the grace window elapses", () => {
    const r = detectZombies({
      detached: [link()], tabsByEnv: tabsByEnv([tab()]),
      now: 20_000, since: new Map([["e:w1:t2", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([{ env: "e", paneId: "w1:p2" }]);
  });

  it("does not reap when the stored tabId is absent from the tab list (herdr churn)", () => {
    const r = detectZombies({
      detached: [link()], tabsByEnv: tabsByEnv([]),
      now: 20_000, since: new Map([["e:w1:t2", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);
  });

  it("does not reap when the tab's workspaceId disagrees (id reuse after restart)", () => {
    const r = detectZombies({
      detached: [link()], tabsByEnv: tabsByEnv([tab({ workspaceId: "wDIFFERENT" })]),
      now: 20_000, since: new Map([["e:w1:t2", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);
  });

  it("reaps even when the herdr tab was renamed since spawn (stored label is stale)", () => {
    // corral itself renames herdr tabs to the Claude session name, so link.tabLabel goes stale — the
    // guard must NOT compare it, only the stable tabId + workspaceId.
    const r = detectZombies({
      detached: [link({ tabLabel: "test-corral-b" })], tabsByEnv: tabsByEnv([tab({ label: "test-corral-5" })]),
      now: 20_000, since: new Map([["e:w1:t2", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([{ env: "e", paneId: "w1:p2" }]);
  });

  it("ignores a link with an empty tabId", () => {
    const r = detectZombies({
      detached: [link({ tabId: "" })], tabsByEnv: tabsByEnv([tab({ tabId: "" })]),
      now: 20_000, since: new Map([["e:", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);
  });

  it("seeds a fresh timer (now) on first detection and does not reap yet", () => {
    const r = detectZombies({
      detached: [link()], tabsByEnv: tabsByEnv([tab()]),
      now: 1000, since: new Map(), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);
    expect(r.since.get("e:w1:t2")).toBe(1000);
  });

  it("preserves the earlier first-seen timestamp across calls (does not restart the clock)", () => {
    const r = detectZombies({
      detached: [link()], tabsByEnv: tabsByEnv([tab()]),
      now: 5000, since: new Map([["e:w1:t2", 1000]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);            // 5000 - 1000 = 4000 < 20000
    expect(r.since.get("e:w1:t2")).toBe(1000); // kept, not reset to 5000
  });

  it("drops the timer when a previously-seen candidate no longer qualifies", () => {
    const r = detectZombies({
      detached: [link()], tabsByEnv: tabsByEnv([]), // tab gone this round
      now: 30_000, since: new Map([["e:w1:t2", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);
    expect(r.since.has("e:w1:t2")).toBe(false);
  });

  it("reaps multiple independent zombies once each has aged past the grace", () => {
    const r = detectZombies({
      detached: [
        link({ paneId: "w1:p2", tabId: "w1:t2", tabLabel: "task-a", workspaceId: "w1" }),
        link({ paneId: "w2:p3", tabId: "w2:t3", tabLabel: "other-a", workspaceId: "w2" }),
      ],
      tabsByEnv: tabsByEnv([tab(), tab({ tabId: "w2:t3", label: "other-a", workspaceId: "w2" })]),
      now: 20_000, since: new Map([["e:w1:t2", 0], ["e:w2:t3", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([{ env: "e", paneId: "w1:p2" }, { env: "e", paneId: "w2:p3" }]);
  });
});

// ---- glue: startZombieReaper wires poller snapshots + storage + herdr into the pure detector ----

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function boardWithLink(over: Partial<{ tabId: string; paneId: string; sessionId: string | null; tabLabel: string }> = {}): Board {
  return {
    id: "b", label: "B", columns: [],
    tasks: [{
      id: "t_aaaaaaa", title: "x", description: "", status: "todo", priority: null, repo: null,
      sessions: [{
        env: "work-local", paneId: over.paneId ?? "w1:p2", tabId: over.tabId ?? "w1:t2",
        tabLabel: over.tabLabel ?? "task-a", workspaceId: "w1", workspaceLabel: "c", name: "task-a",
        cwdSnapshot: "/c", sessionId: over.sessionId ?? SID,
      }],
      createdAt: 1, updatedAt: 1,
    }],
  };
}

const rawTab = (o: { tab_id: string; label: string; workspace_id: string }): { tab_id: string; label: string; workspace_id: string } => o;

function harness(opts: {
  snapshot: Snapshot;
  boards: Board[];
  tabs: { tab_id: string; label: string; workspace_id: string }[];
}): {
  fire: () => void;
  closed: { paneId: string }[];
  listCalls: number;
  setClock: (n: number) => void;
} {
  let cb: ((s: Snapshot) => void) | null = null;
  const closed: { paneId: string }[] = [];
  let listCalls = 0;
  let clock = 0;
  startZombieReaper({
    poller: { getSnapshot: () => opts.snapshot, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
    storage: { getAllBoards: () => opts.boards },
    envs: [getEnv("work-local")],
    listTabs: () => { listCalls++; return Promise.resolve(opts.tabs); },
    closePane: (_e, paneId) => { closed.push({ paneId }); return Promise.resolve(); },
    now: () => clock,
    graceMs: 20_000,
  });
  return {
    fire: () => cb?.(opts.snapshot),
    closed,
    get listCalls() { return listCalls; },
    setClock: (n) => { clock = n; },
  };
}

describe("startZombieReaper", () => {
  it("pane-closes a detached link whose tab lingers, once the grace elapses across snapshots", async () => {
    // Empty sessions → the link is detached; the tab still exists in tab list → zombie.
    const h = harness({
      snapshot: { envs: { "work-local": { reachable: true } }, sessions: [] },
      boards: [boardWithLink()],
      tabs: [rawTab({ tab_id: "w1:t2", label: "task-a", workspace_id: "w1" })],
    });
    h.setClock(0); h.fire(); await flush();
    expect(h.closed).toEqual([]);            // first sighting → timer seeded, no reap
    h.setClock(20_000); h.fire(); await flush();
    expect(h.closed).toEqual([{ paneId: "w1:p2" }]);
  });

  it("never reaps on an unreachable env (herdr down / restarting)", async () => {
    const h = harness({
      snapshot: { envs: { "work-local": { reachable: false, error: "down" } }, sessions: [] },
      boards: [boardWithLink()],
      tabs: [rawTab({ tab_id: "w1:t2", label: "task-a", workspace_id: "w1" })],
    });
    h.setClock(0); h.fire(); await flush();
    h.setClock(20_000); h.fire(); await flush();
    expect(h.closed).toEqual([]);
    expect(h.listCalls).toBe(0);             // did not even query tabs on an unreachable env
  });

  it("ignores a live (non-detached) link", async () => {
    const live: Snapshot = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        env: "work-local", paneId: "w1:p2", status: "idle", agent: "claude", cwd: "/c",
        tab: "task-a", workspace: "c", tabId: "w1:t2", workspaceId: "w1", sessionId: SID,
        recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null,
      }],
    };
    const h = harness({
      snapshot: live, boards: [boardWithLink()],
      tabs: [rawTab({ tab_id: "w1:t2", label: "task-a", workspace_id: "w1" })],
    });
    h.setClock(0); h.fire(); await flush();
    h.setClock(20_000); h.fire(); await flush();
    expect(h.closed).toEqual([]);
  });
});
