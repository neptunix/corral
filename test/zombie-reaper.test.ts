import type { Board } from "@shared/board-schema";
import type { Snapshot } from "@shared/schema";
import { describe, expect, it, vi } from "vitest";

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
    expect(r.reap).toEqual([{ env: "e", paneId: "w1:p2", tabId: "w1:t2", firstSeenAt: 0 }]);
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
    expect(r.reap).toEqual([{ env: "e", paneId: "w1:p2", tabId: "w1:t2", firstSeenAt: 0 }]);
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
    expect(r.reap).toEqual([
      { env: "e", paneId: "w1:p2", tabId: "w1:t2", firstSeenAt: 0 },
      { env: "e", paneId: "w2:p3", tabId: "w2:t3", firstSeenAt: 0 },
    ]);
  });
});

// ---- glue: startZombieReaper wires poller snapshots + storage + herdr into the pure detector ----

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SID2 = "eeeeeeee-ffff-0000-1111-222222222222";

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

  it("does NOT reap a pane now occupied by a DIFFERENT live session (shell reused after Claude exited)", async () => {
    // link's own session S1 ended, but the user ran `claude` again in the lingering shell → a new
    // session S2 now holds the SAME pane/tab. resolveLiveRow reports the link detached (S1 gone), yet
    // reaping link.paneId would kill S2. The reaper must skip a pane that hosts a live agent.
    const S2 = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const h = harness({
      snapshot: { envs: { "work-local": { reachable: true } }, sessions: [{
        env: "work-local", paneId: "w1:p2", status: "idle", agent: "claude", cwd: "/c",
        tab: "task-a", workspace: "c", tabId: "w1:t2", workspaceId: "w1", sessionId: S2,
        recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null,
      }] },
      boards: [boardWithLink({ sessionId: SID })], // link.sessionId = S1 (ended)
      tabs: [rawTab({ tab_id: "w1:t2", label: "task-a", workspace_id: "w1" })],
    });
    h.setClock(0); h.fire(); await flush();
    h.setClock(20_000); h.fire(); await flush();
    expect(h.closed).toEqual([]);
  });

  it("does NOT reap a pane a session takes over DURING the listTabs await (TOCTOU)", async () => {
    // The pane is an agentless zombie when candidates are chosen, but a session starts in it while we
    // await listTabs. Reaping on the now-stale decision would kill it — the close must re-check.
    const S2 = "cccccccc-dddd-eeee-ffff-000000000000";
    const zombie: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
    const reused: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [{
      env: "work-local", paneId: "w1:p2", status: "idle", agent: "claude", cwd: "/c",
      tab: "task-a", workspace: "c", tabId: "w1:t2", workspaceId: "w1", sessionId: S2,
      recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null,
    }] };
    let snap: Snapshot = zombie;
    let clock = 0;
    const closed: string[] = [];
    let cb: ((s: Snapshot) => void) | null = null;
    startZombieReaper({
      poller: { getSnapshot: () => snap, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
      storage: { getAllBoards: () => [boardWithLink({ sessionId: SID })] },
      envs: [getEnv("work-local")],
      listTabs: () => { if (clock >= 20_000) snap = reused; return Promise.resolve([rawTab({ tab_id: "w1:t2", label: "task-a", workspace_id: "w1" })]); },
      closePane: (_e, paneId) => { closed.push(paneId); return Promise.resolve(); },
      now: () => clock, graceMs: 20_000,
    });
    clock = 0; cb!(zombie); await flush();          // seed the timer (pane still empty)
    clock = 20_000; cb!(zombie); await flush();      // listTabs flips the pane to a live session mid-tick
    expect(closed).toEqual([]);
  });

  it("serializes overlapping polls: a snapshot fired while a tick is in flight is skipped (inFlight)", async () => {
    let release: () => void = () => void 0;
    let listCalls = 0;
    const snap: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
    let cb: ((s: Snapshot) => void) | null = null;
    startZombieReaper({
      poller: { getSnapshot: () => snap, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
      storage: { getAllBoards: () => [boardWithLink()] },
      envs: [getEnv("work-local")],
      listTabs: () => { listCalls++; return new Promise((res) => { release = () => { res([rawTab({ tab_id: "w1:t2", label: "task-a", workspace_id: "w1" })]); }; }); },
      closePane: () => Promise.resolve(),
      now: () => 0, graceMs: 20_000,
    });
    cb!(snap); await flush();  // tick 1 reaches listTabs and parks there (inFlight = true)
    cb!(snap); await flush();  // tick 2 must short-circuit before touching listTabs
    expect(listCalls).toBe(1);
    release(); await flush();
  });

  it("isolates a closePane failure: one zombie's close error doesn't abort the others or escape the tick", async () => {
    const link = (paneId: string, tabId: string, ws: string, sid: string): typeof board.tasks[0]["sessions"][0] => ({
      env: "work-local", paneId, tabId, tabLabel: "z", workspaceId: ws, workspaceLabel: "c", name: "z", cwdSnapshot: "/c", sessionId: sid,
    });
    const board: Board = {
      id: "b", label: "B", columns: [],
      tasks: [{ id: "t", title: "x", description: "", status: "todo", priority: null, repo: null, createdAt: 1, updatedAt: 1,
        sessions: [link("w1:p2", "w1:t2", "w1", SID), link("w2:p3", "w2:t3", "w2", "dddddddd-1111-2222-3333-444444444444")] }],
    };
    const closed: string[] = [];
    let clock = 0;
    let cb: ((s: Snapshot) => void) | null = null;
    const empty: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
    startZombieReaper({
      poller: { getSnapshot: () => empty, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
      storage: { getAllBoards: () => [board] },
      envs: [getEnv("work-local")],
      listTabs: () => Promise.resolve([rawTab({ tab_id: "w1:t2", label: "z", workspace_id: "w1" }), rawTab({ tab_id: "w2:t3", label: "z", workspace_id: "w2" })]),
      closePane: (_e, paneId) => {
        if (paneId === "w1:p2") return Promise.reject(new Error("boom"));
        closed.push(paneId);
        return Promise.resolve();
      },
      now: () => clock, graceMs: 20_000,
    });
    clock = 0; cb!(empty); await flush();
    clock = 20_000; cb!(empty); await flush();
    expect(closed).toEqual(["w2:p3"]); // w1's rejection was caught; w2 still reaped; no unhandled rejection
  });

  it("restarts the grace window when a poll inside it shows the agent back (freshly-spawned session)", async () => {
    // The regression the grace floor exists for: a poll captured in the sub-second gap between herdr
    // creating a pane and registering the Claude in it makes a LIVE session look detached and seeds the
    // timer. The next poll shows the agent, so the timer must drop.
    //
    // TWO links on purpose. With one, the agent's return empties the candidate list and `since` is wiped
    // by the byEnv.size === 0 branch — so a single-link version passes even if the per-round rebuild in
    // detectZombies is removed (mutation-verified). B stays detached, keeping rounds non-empty, so only
    // the rebuild can save A.
    const sess = (paneId: string, tabId: string, ws: string, sid: string): Board["tasks"][0]["sessions"][0] => ({
      env: "work-local", paneId, tabId, tabLabel: "z", workspaceId: ws, workspaceLabel: "c",
      name: "z", cwdSnapshot: "/c", sessionId: sid,
    });
    const board: Board = {
      id: "b", label: "B", columns: [],
      tasks: [{ id: "t", title: "x", description: "", status: "todo", priority: null, repo: null,
        createdAt: 1, updatedAt: 1, sessions: [sess("w1:p2", "w1:t2", "w1", SID), sess("w2:p3", "w2:t3", "w2", SID2)] }],
    };
    const empty: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
    const aLive: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [{
      env: "work-local", paneId: "w1:p2", status: "working", agent: "claude", cwd: "/c",
      tab: "z", workspace: "c", tabId: "w1:t2", workspaceId: "w1", sessionId: SID,
      recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null,
    }] };
    let snap: Snapshot = empty;
    let clock = 0;
    const closed: string[] = [];
    let cb: ((s: Snapshot) => void) | null = null;
    startZombieReaper({
      poller: { getSnapshot: () => snap, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
      storage: { getAllBoards: () => [board] },
      envs: [getEnv("work-local")],
      listTabs: () => Promise.resolve([
        rawTab({ tab_id: "w1:t2", label: "z", workspace_id: "w1" }),
        rawTab({ tab_id: "w2:t3", label: "z", workspace_id: "w2" }),
      ]),
      closePane: (_e, paneId) => { closed.push(paneId); return Promise.resolve(); },
      now: () => clock, graceMs: 20_000,
    });

    clock = 0; cb!(empty); await flush();          // both seeded
    snap = aLive; clock = 5_000; cb!(snap); await flush();   // A's agent registers → A's timer drops
    snap = empty; clock = 10_000; cb!(empty); await flush(); // A really exits → NEW window from here
    expect(closed).toEqual([]);
    clock = 21_000; cb!(empty); await flush();
    expect(closed).toEqual(["w2:p3"]);             // B aged from 0; A's window runs to 30_000
  });

  it("re-seeds instead of reaping when ticks stopped for a whole grace (host suspend)", async () => {
    // Wall clock advances while the poll loop does not, so no poll could have refuted the pending timer
    // and every env's rows predate the gap. Reaping there would kill a live pane on one stale sighting.
    const empty: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
    let clock = 0;
    const closed: string[] = [];
    let cb: ((s: Snapshot) => void) | null = null;
    startZombieReaper({
      poller: { getSnapshot: () => empty, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
      storage: { getAllBoards: () => [boardWithLink()] },
      envs: [getEnv("work-local")],
      listTabs: () => Promise.resolve([rawTab({ tab_id: "w1:t2", label: "task-a", workspace_id: "w1" })]),
      closePane: (_e, paneId) => { closed.push(paneId); return Promise.resolve(); },
      now: () => clock, graceMs: 20_000,
    });
    clock = 0; cb!(empty); await flush();
    clock = 60_000; cb!(empty); await flush();      // 60s tick gap > grace → clocks dropped, re-seeded
    expect(closed).toEqual([]);
    clock = 70_000; cb!(empty); await flush();      // normal cadence resumes; window runs from 60_000
    expect(closed).toEqual([]);
    clock = 80_000; cb!(empty); await flush();
    expect(closed).toEqual(["w1:p2"]);
  });

  it("logs every reap as a zombie_reaped line, and logs nothing when the close fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => void 0);
    try {
      const h = harness({
        snapshot: { envs: { "work-local": { reachable: true } }, sessions: [] },
        boards: [boardWithLink()],
        tabs: [rawTab({ tab_id: "w1:t2", label: "task-a", workspace_id: "w1" })],
      });
      h.setClock(0); h.fire(); await flush();
      h.setClock(20_000); h.fire(); await flush();
      const lines = warn.mock.calls.flat().filter((a): a is string => typeof a === "string" && a.includes("zombie_reaped"));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toEqual({
        event: "zombie_reaped", env: "work-local", pane: "w1:p2", tab: "w1:t2",
        detached_for_ms: 20_000, grace_ms: 20_000,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("does not log a reap when closePane rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => void 0);
    try {
      let clock = 0;
      let cb: ((s: Snapshot) => void) | null = null;
      const empty: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
      startZombieReaper({
        poller: { getSnapshot: () => empty, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
        storage: { getAllBoards: () => [boardWithLink()] },
        envs: [getEnv("work-local")],
        listTabs: () => Promise.resolve([rawTab({ tab_id: "w1:t2", label: "task-a", workspace_id: "w1" })]),
        closePane: () => Promise.reject(new Error("boom")),
        now: () => clock, graceMs: 20_000,
      });
      clock = 0; cb!(empty); await flush();
      clock = 20_000; cb!(empty); await flush();
      const logged = warn.mock.calls.flat().some((a) => typeof a === "string" && a.includes("zombie_reaped"));
      expect(logged).toBe(false); // a failed close must never read as a completed reap
    } finally {
      warn.mockRestore();
    }
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
