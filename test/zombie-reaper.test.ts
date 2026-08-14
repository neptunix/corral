import type { Board } from "@shared/board-schema";
import type { Snapshot } from "@shared/schema";
import { describe, expect, it, vi } from "vitest";

import { getEnv } from "../environments.ts";
import type { PaneIdentity } from "../server/herdr.ts";
import { detectZombies, startZombieReaper, type ReapCandidateLink } from "../server/zombie-reaper.ts";

const link = (over: Partial<ReapCandidateLink> = {}): ReapCandidateLink => ({
  env: "e", paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", ...over,
});
const pane = (over: Partial<PaneIdentity> = {}): PaneIdentity => ({
  paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false, ...over,
});
const panesByEnv = (panes: PaneIdentity[]): Map<string, PaneIdentity[]> => new Map([["e", panes]]);

describe("detectZombies", () => {
  it("reaps a detached candidate whose pane still exists once the grace window elapses", () => {
    const r = detectZombies({
      detached: [link()], panesByEnv: panesByEnv([pane()]),
      now: 20_000, since: new Map([["e:w1:p2", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([{ env: "e", paneId: "w1:p2", tabId: "w1:t2", firstSeenAt: 0 }]);
  });

  it("does not reap when the stored paneId is absent from the pane list (herdr churn)", () => {
    const r = detectZombies({
      detached: [link()], panesByEnv: panesByEnv([]),
      now: 20_000, since: new Map([["e:w1:p2", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);
  });

  it("ignores a link with an empty tabId", () => {
    const r = detectZombies({
      detached: [link({ tabId: "" })], panesByEnv: panesByEnv([pane({ tabId: "" })]),
      now: 20_000, since: new Map([["e:w1:p2", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);
  });

  it("seeds a fresh timer (now) on first detection and does not reap yet", () => {
    const r = detectZombies({
      detached: [link()], panesByEnv: panesByEnv([pane()]),
      now: 1000, since: new Map(), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);
    expect(r.since.get("e:w1:p2")).toBe(1000);
  });

  it("preserves the earlier first-seen timestamp across calls (does not restart the clock)", () => {
    const r = detectZombies({
      detached: [link()], panesByEnv: panesByEnv([pane()]),
      now: 5000, since: new Map([["e:w1:p2", 1000]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);            // 5000 - 1000 = 4000 < 20000
    expect(r.since.get("e:w1:p2")).toBe(1000); // kept, not reset to 5000
  });

  it("drops the timer when a previously-seen candidate no longer qualifies", () => {
    const r = detectZombies({
      detached: [link()], panesByEnv: panesByEnv([]), // pane gone this round
      now: 30_000, since: new Map([["e:w1:p2", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);
    expect(r.since.has("e:w1:p2")).toBe(false);
  });

  it("reaps multiple independent zombies once each has aged past the grace", () => {
    const r = detectZombies({
      detached: [
        link({ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" }),
        link({ paneId: "w2:p3", tabId: "w2:t3", workspaceId: "w2" }),
      ],
      panesByEnv: panesByEnv([pane(), pane({ paneId: "w2:p3", tabId: "w2:t3", workspaceId: "w2" })]),
      now: 20_000, since: new Map([["e:w1:p2", 0], ["e:w2:p3", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([
      { env: "e", paneId: "w1:p2", tabId: "w1:t2", firstSeenAt: 0 },
      { env: "e", paneId: "w2:p3", tabId: "w2:t3", firstSeenAt: 0 },
    ]);
  });

  it("does not reap when the stored pane is absent from the pane list (the tab outlived its pane)", () => {
    // The reported bug: tab w1:t2 still exists, but pane w1:p2 does not. Closing it fails forever.
    const r = detectZombies({
      detached: [link()], panesByEnv: panesByEnv([pane({ paneId: "w1:pQ" })]),
      now: 20_000, since: new Map([["e:w1:p2", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);
    expect(r.since.has("e:w1:p2")).toBe(false);   // and the timer is dropped, so it cannot re-fire
  });

  it("does not reap when the pane now lives in a different tab", () => {
    const r = detectZombies({
      detached: [link()], panesByEnv: panesByEnv([pane({ tabId: "w1:t9" })]),
      now: 20_000, since: new Map([["e:w1:p2", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);
  });

  it("does not reap when the pane's workspaceId disagrees (id reuse after state loss)", () => {
    const r = detectZombies({
      detached: [link()], panesByEnv: panesByEnv([pane({ workspaceId: "wDIFFERENT" })]),
      now: 20_000, since: new Map([["e:w1:p2", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);
  });

  it("does not reap a pane that has an agent registered on it", () => {
    const r = detectZombies({
      detached: [link()], panesByEnv: panesByEnv([pane({ hasAgent: true })]),
      now: 20_000, since: new Map([["e:w1:p2", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);
  });

  it("does not accept a same-id pane from a DIFFERENT env as evidence", () => {
    const r = detectZombies({
      detached: [link({ env: "a" })],
      panesByEnv: new Map([["b", [pane()]]]),   // env b has w1:p2; env a's list is absent
      now: 20_000, since: new Map([["a:w1:p2", 0]]), graceMs: 20_000,
    });
    expect(r.reap).toEqual([]);
    expect(r.since.has("a:w1:p2")).toBe(false);
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
      id: "t_aaaaaaa", title: "x", description: "", status: "todo", priority: null,
      sessions: [{
        env: "work-local", paneId: over.paneId ?? "w1:p2", tabId: over.tabId ?? "w1:t2",
        tabLabel: over.tabLabel ?? "task-a", workspaceId: "w1", workspaceLabel: "c", name: "task-a",
        cwdSnapshot: "/c", sessionId: over.sessionId ?? SID,
      }],
      createdAt: 1, updatedAt: 1,
    }],
    spawnPresets: [], defaultSpawnPresetId: null,
  };
}

function harness(opts: {
  snapshot: Snapshot;
  boards: Board[];
  panes: PaneIdentity[];
}): {
  fire: () => void;
  closed: { env: string; paneId: string }[];
  listCalls: number;
  setClock: (n: number) => void;
} {
  let cb: ((s: Snapshot) => void) | null = null;
  const closed: { env: string; paneId: string }[] = [];
  let listCalls = 0;
  let clock = 0;
  startZombieReaper({
    poller: { getSnapshot: () => opts.snapshot, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
    storage: { getAllBoards: () => opts.boards },
    envs: [getEnv("work-local")],
    listPanes: () => { listCalls++; return Promise.resolve(opts.panes); },
    closePane: (e, paneId) => { closed.push({ env: e.id, paneId }); return Promise.resolve(); },
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
  it("pane-closes a detached link whose pane lingers, once the grace elapses across snapshots", async () => {
    // Empty sessions → the link is detached; the pane still exists in pane list → zombie.
    const h = harness({
      snapshot: { envs: { "work-local": { reachable: true } }, sessions: [] },
      boards: [boardWithLink()],
      panes: [{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }],
    });
    h.setClock(0); h.fire(); await flush();
    expect(h.closed).toEqual([]);            // first sighting → timer seeded, no reap
    h.setClock(20_000); h.fire(); await flush();
    expect(h.closed).toEqual([{ env: "work-local", paneId: "w1:p2" }]);
  });

  it("routes the pane-list fetch and the close to the env that actually owns the candidate, not always the first configured env", async () => {
    // herdr numbers panes per session from w1:p1 upward, so the SAME paneId/tabId exists on nearly
    // every environment. Only personal-local's pane list actually carries the candidate — if either
    // call were misrouted to the first configured env (work-local), the close would land on the
    // wrong host, or the candidate would look absent everywhere and never reap at all.
    const closed: { env: string; paneId: string }[] = [];
    const queriedEnvs: string[] = [];
    let clock = 0;
    let cb: ((s: Snapshot) => void) | null = null;
    const snap: Snapshot = {
      envs: { "work-local": { reachable: true }, "personal-local": { reachable: true } },
      sessions: [],
    };
    const board: Board = {
      id: "b", label: "B", columns: [],
      tasks: [{
        id: "t", title: "x", description: "", status: "todo", priority: null, createdAt: 1, updatedAt: 1,
        sessions: [
          { env: "work-local", paneId: "w1:p2", tabId: "w1:t2", tabLabel: "z", workspaceId: "w1", workspaceLabel: "c", name: "z", cwdSnapshot: "/c", sessionId: SID },
          { env: "personal-local", paneId: "w1:p2", tabId: "w1:t2", tabLabel: "z", workspaceId: "w1", workspaceLabel: "c", name: "z", cwdSnapshot: "/c", sessionId: SID2 },
        ],
      }],
      spawnPresets: [], defaultSpawnPresetId: null,
    };
    startZombieReaper({
      poller: { getSnapshot: () => snap, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
      storage: { getAllBoards: () => [board] },
      envs: [getEnv("work-local"), getEnv("personal-local")],
      listPanes: (env) => {
        queriedEnvs.push(env.id);
        return Promise.resolve(
          env.id === "personal-local" ? [{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }] : [],
        );
      },
      closePane: (env, paneId) => { closed.push({ env: env.id, paneId }); return Promise.resolve(); },
      now: () => clock, graceMs: 20_000,
    });
    clock = 0; cb!(snap); await flush();
    clock = 20_000; cb!(snap); await flush();
    // listPanes runs once per env per tick (two ticks here) — dedupe to the set of envs queried.
    expect([...new Set(queriedEnvs)].sort()).toEqual(["personal-local", "work-local"]);
    expect(closed).toEqual([{ env: "personal-local", paneId: "w1:p2" }]);
  });

  it("skips an unreachable env's candidates entirely even when a different env is reachable (per-env churn rail, not a fleet-wide OR)", async () => {
    // work-local is down; personal-local is up. Reaping must stay scoped to personal-local — an
    // env-wide reachability check that ORs across every env would also query and reap work-local
    // while it cannot be trusted, defeating the churn rail described in the file header.
    const closed: { env: string; paneId: string }[] = [];
    const queriedEnvs: string[] = [];
    let clock = 0;
    let cb: ((s: Snapshot) => void) | null = null;
    const snap: Snapshot = {
      envs: { "work-local": { reachable: false, error: "down" }, "personal-local": { reachable: true } },
      sessions: [],
    };
    const board: Board = {
      id: "b", label: "B", columns: [],
      tasks: [{
        id: "t", title: "x", description: "", status: "todo", priority: null, createdAt: 1, updatedAt: 1,
        sessions: [
          { env: "work-local", paneId: "w1:p2", tabId: "w1:t2", tabLabel: "z", workspaceId: "w1", workspaceLabel: "c", name: "z", cwdSnapshot: "/c", sessionId: SID },
          { env: "personal-local", paneId: "w1:p2", tabId: "w1:t2", tabLabel: "z", workspaceId: "w1", workspaceLabel: "c", name: "z", cwdSnapshot: "/c", sessionId: SID2 },
        ],
      }],
      spawnPresets: [], defaultSpawnPresetId: null,
    };
    startZombieReaper({
      poller: { getSnapshot: () => snap, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
      storage: { getAllBoards: () => [board] },
      envs: [getEnv("work-local"), getEnv("personal-local")],
      listPanes: (env) => {
        queriedEnvs.push(env.id);
        return Promise.resolve([{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }]);
      },
      closePane: (env, paneId) => { closed.push({ env: env.id, paneId }); return Promise.resolve(); },
      now: () => clock, graceMs: 20_000,
    });
    clock = 0; cb!(snap); await flush();
    clock = 20_000; cb!(snap); await flush();
    // listPanes runs once per env per tick (two ticks here) — dedupe to the set of envs queried.
    expect([...new Set(queriedEnvs)]).toEqual(["personal-local"]);
    expect(closed).toEqual([{ env: "personal-local", paneId: "w1:p2" }]);
  });

  it("never reaps on an unreachable env (herdr down / restarting)", async () => {
    const h = harness({
      snapshot: { envs: { "work-local": { reachable: false, error: "down" } }, sessions: [] },
      boards: [boardWithLink()],
      panes: [{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }],
    });
    h.setClock(0); h.fire(); await flush();
    h.setClock(20_000); h.fire(); await flush();
    expect(h.closed).toEqual([]);
    expect(h.listCalls).toBe(0);             // did not even query panes on an unreachable env
  });

  it("a listPanes rejection reaps nothing, warns once, and drops the candidate's grace timer (no accumulation across a flaky env)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const snap: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
      let clock = 0;
      let shouldFail = false;
      let cb: ((s: Snapshot) => void) | null = null;
      const closed: string[] = [];
      startZombieReaper({
        poller: { getSnapshot: () => snap, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
        storage: { getAllBoards: () => [boardWithLink()] },
        envs: [getEnv("work-local")],
        listPanes: () => shouldFail
          ? Promise.reject(new Error("ssh timeout"))
          : Promise.resolve([{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }]),
        closePane: (_e, paneId) => { closed.push(paneId); return Promise.resolve(); },
        now: () => clock, graceMs: 20_000,
      });
      clock = 0; cb!(snap); await flush();                  // seeds the timer at 0
      shouldFail = true;
      clock = 10_000; cb!(snap); await flush();              // listPanes rejects: no entry in panesByEnv
      clock = 12_000; cb!(snap); await flush();              // and rejects again on the very next tick
      expect(closed).toEqual([]);
      // The failure is reported (a silently un-listable env would lose reaping with no signal), but
      // only once per env — this can reject on every tick for as long as the host is unreachable.
      const listWarnings = warn.mock.calls.flat().filter(
        (a): a is string => typeof a === "string" && a.includes("pane list failed"),
      );
      expect(listWarnings).toHaveLength(1);
      expect(listWarnings[0]).toContain("env=work-local");
      expect(listWarnings[0]).toContain("ssh timeout");     // carries the underlying error, not just "failed"
      shouldFail = false;
      // Recovers at 25_000 — if the earlier timer (seeded at 0) had survived the failure, 25_000 - 0 =
      // 25_000 >= grace would reap NOW. It does not: the failed tick dropped it, so this is a fresh seed.
      clock = 25_000; cb!(snap); await flush();
      expect(closed).toEqual([]);
      clock = 45_000; cb!(snap); await flush();              // full grace elapsed from the 25_000 re-seed
      expect(closed).toEqual(["w1:p2"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("isolates a per-env pane-list failure: a fast-rejecting env does not starve a slower healthy one", async () => {
    // work-local's list rejects immediately (SSH connection refused); personal-local's resolves a
    // macrotask later (a local call that still takes a few ms). The catch must sit INSIDE the
    // per-env task: hoisted around the whole Promise.all, the first rejection settles the await
    // before the healthy env's panes ever land, so personal-local sees an empty pane list, drops its
    // timer and never reaps — a real regression that every other test in this file misses.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const closed: { env: string; paneId: string }[] = [];
      let clock = 0;
      let cb: ((s: Snapshot) => void) | null = null;
      const snap: Snapshot = {
        envs: { "work-local": { reachable: true }, "personal-local": { reachable: true } },
        sessions: [],
      };
      const board: Board = {
        id: "b", label: "B", columns: [],
        tasks: [{
          id: "t", title: "x", description: "", status: "todo", priority: null, createdAt: 1, updatedAt: 1,
          sessions: [
            { env: "work-local", paneId: "w1:p2", tabId: "w1:t2", tabLabel: "z", workspaceId: "w1", workspaceLabel: "c", name: "z", cwdSnapshot: "/c", sessionId: SID },
            { env: "personal-local", paneId: "w1:p2", tabId: "w1:t2", tabLabel: "z", workspaceId: "w1", workspaceLabel: "c", name: "z", cwdSnapshot: "/c", sessionId: SID2 },
          ],
        }],
        spawnPresets: [], defaultSpawnPresetId: null,
      };
      startZombieReaper({
        poller: { getSnapshot: () => snap, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
        storage: { getAllBoards: () => [board] },
        envs: [getEnv("work-local"), getEnv("personal-local")],
        listPanes: (env) => env.id === "work-local"
          ? Promise.reject(new Error("connection refused"))
          : new Promise((res) => { setTimeout(() => { res([{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }]); }, 0); }),
        closePane: (env, paneId) => { closed.push({ env: env.id, paneId }); return Promise.resolve(); },
        now: () => clock, graceMs: 20_000,
      });
      clock = 0; cb!(snap); await flush(); await flush();
      clock = 20_000; cb!(snap); await flush(); await flush();
      expect(closed).toEqual([{ env: "personal-local", paneId: "w1:p2" }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("dedupes two detached links on the same pane into a single reap (no spurious pane_not_found)", async () => {
    // api.ts's AttachBodySchema allows re-attaching, so two tasks can each hold a link to the same
    // pane. Without dedup both become ReapDecisions and race two closePane calls; the loser (simulated
    // here by rejecting a repeat close on the same paneId) would log a spurious failure.
    const linkSession = (sid: string): Board["tasks"][0]["sessions"][0] => ({
      env: "work-local", paneId: "w1:p2", tabId: "w1:t2", tabLabel: "z", workspaceId: "w1", workspaceLabel: "c",
      name: "z", cwdSnapshot: "/c", sessionId: sid,
    });
    const board: Board = {
      id: "b", label: "B", columns: [],
      tasks: [
        { id: "t1", title: "x", description: "", status: "todo", priority: null, createdAt: 1, updatedAt: 1, sessions: [linkSession(SID)] },
        { id: "t2", title: "y", description: "", status: "todo", priority: null, createdAt: 1, updatedAt: 1, sessions: [linkSession(SID2)] },
      ],
      spawnPresets: [], defaultSpawnPresetId: null,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const closed: string[] = [];
      const alreadyClosed = new Set<string>();
      let clock = 0;
      let cb: ((s: Snapshot) => void) | null = null;
      const empty: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
      startZombieReaper({
        poller: { getSnapshot: () => empty, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
        storage: { getAllBoards: () => [board] },
        envs: [getEnv("work-local")],
        listPanes: () => Promise.resolve([{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }]),
        closePane: (_e, paneId) => {
          if (alreadyClosed.has(paneId)) return Promise.reject(new Error("pane_not_found"));
          alreadyClosed.add(paneId);
          closed.push(paneId);
          return Promise.resolve();
        },
        now: () => clock, graceMs: 20_000,
      });
      clock = 0; cb!(empty); await flush();
      clock = 20_000; cb!(empty); await flush();
      expect(closed).toEqual(["w1:p2"]); // exactly one close, not one per link
      expect(warn.mock.calls.flat().filter((a) => typeof a === "string" && a.includes("zombie-reaper"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("dedupes AFTER identity validation: a stale duplicate link does not hide the valid one", async () => {
    // Two detached links on the same pane, iterated in board order. The FIRST carries a stale tabId
    // (the pane's old tab, recorded before it moved); the second matches the live pane. Collapsing
    // duplicates during collection keeps only the first, which then fails the tab check — and the
    // valid sibling is never examined, on this tick or any other, because iteration order is stable.
    const linkSession = (tabId: string, sid: string): Board["tasks"][0]["sessions"][0] => ({
      env: "work-local", paneId: "w1:p2", tabId, tabLabel: "z", workspaceId: "w1", workspaceLabel: "c",
      name: "z", cwdSnapshot: "/c", sessionId: sid,
    });
    const board: Board = {
      id: "b", label: "B", columns: [],
      tasks: [
        { id: "t1", title: "x", description: "", status: "todo", priority: null, createdAt: 1, updatedAt: 1, sessions: [linkSession("w1:t1", SID)] },
        { id: "t2", title: "y", description: "", status: "todo", priority: null, createdAt: 1, updatedAt: 1, sessions: [linkSession("w1:t2", SID2)] },
      ],
      spawnPresets: [], defaultSpawnPresetId: null,
    };
    const closed: string[] = [];
    let clock = 0;
    let cb: ((s: Snapshot) => void) | null = null;
    const empty: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
    startZombieReaper({
      poller: { getSnapshot: () => empty, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
      storage: { getAllBoards: () => [board] },
      envs: [getEnv("work-local")],
      listPanes: () => Promise.resolve([{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }]),
      closePane: (_e, paneId) => { closed.push(paneId); return Promise.resolve(); },
      now: () => clock, graceMs: 20_000,
    });
    clock = 0; cb!(empty); await flush();
    clock = 20_000; cb!(empty); await flush();
    expect(closed).toEqual(["w1:p2"]); // the valid link still reaps, and only once
  });

  it("seeds no grace timer while the agent-list index shows the pane occupied (pre-filter, not just the close check)", async () => {
    // The pre-filter's own, distinct effect: an occupied pane starts NO clock. Occupancy here is
    // visible only in the poller's agent-list index — `pane list` already reports the pane free, which
    // a snapshot up to one poll interval old can legitimately lag behind. The stranger is gone by the
    // second tick, so the pre-close `fresh` re-read sees nothing and cannot block the close: the
    // pre-filter is the only guard in play. Without it the timer is seeded on tick 1 and the pane is
    // closed with ZERO grace the moment the stranger's agent disappears.
    const S2 = "99999999-8888-7777-6666-555555555555";
    const occupied: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [{
      env: "work-local", paneId: "w1:p2", status: "idle", agent: "claude", cwd: "/c",
      tab: "task-a", workspace: "c", tabId: "w1:t2", workspaceId: "w1", sessionId: S2,
      recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null,
    }] };
    const free: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
    let snap: Snapshot = occupied;
    let clock = 0;
    const closed: string[] = [];
    let cb: ((s: Snapshot) => void) | null = null;
    startZombieReaper({
      poller: { getSnapshot: () => snap, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
      storage: { getAllBoards: () => [boardWithLink({ sessionId: SID })] },   // our own session is gone
      envs: [getEnv("work-local")],
      listPanes: () => Promise.resolve([{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }]),
      closePane: (_e, paneId) => { closed.push(paneId); return Promise.resolve(); },
      now: () => clock, graceMs: 20_000,
    });
    clock = 0; cb!(snap); await flush();                        // stranger holds the pane → no candidate, no timer
    snap = free; clock = 20_000; cb!(snap); await flush();       // stranger gone → the window starts HERE
    expect(closed).toEqual([]);
    clock = 39_999; cb!(snap); await flush();
    expect(closed).toEqual([]);                                  // still inside the window seeded at 20_000
    clock = 40_000; cb!(snap); await flush();
    expect(closed).toEqual(["w1:p2"]);                           // a full grace after the pane came free
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
        recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null,
      }] },
      boards: [boardWithLink({ sessionId: SID })], // link.sessionId = S1 (ended)
      panes: [{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }],
    });
    h.setClock(0); h.fire(); await flush();
    h.setClock(20_000); h.fire(); await flush();
    expect(h.closed).toEqual([]);
  });

  it("does NOT reap a pane a session takes over DURING the listPanes await (TOCTOU)", async () => {
    // The pane is an agentless zombie when candidates are chosen, but a session starts in it while we
    // await listPanes. Reaping on the now-stale decision would kill it — the close must re-check.
    const S2 = "cccccccc-dddd-eeee-ffff-000000000000";
    const zombie: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
    const reused: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [{
      env: "work-local", paneId: "w1:p2", status: "idle", agent: "claude", cwd: "/c",
      tab: "task-a", workspace: "c", tabId: "w1:t2", workspaceId: "w1", sessionId: S2,
      recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null,
    }] };
    let snap: Snapshot = zombie;
    let clock = 0;
    const closed: string[] = [];
    let cb: ((s: Snapshot) => void) | null = null;
    startZombieReaper({
      poller: { getSnapshot: () => snap, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
      storage: { getAllBoards: () => [boardWithLink({ sessionId: SID })] },
      envs: [getEnv("work-local")],
      listPanes: () => { if (clock >= 20_000) snap = reused; return Promise.resolve([{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }]); },
      closePane: (_e, paneId) => { closed.push(paneId); return Promise.resolve(); },
      now: () => clock, graceMs: 20_000,
    });
    clock = 0; cb!(zombie); await flush();          // seed the timer (pane still empty)
    clock = 20_000; cb!(zombie); await flush();      // listPanes flips the pane to a live session mid-tick
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
      listPanes: () => { listCalls++; return new Promise((res) => { release = () => { res([{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }]); }; }); },
      closePane: () => Promise.resolve(),
      now: () => 0, graceMs: 20_000,
    });
    cb!(snap); await flush();  // tick 1 reaches listPanes and parks there (inFlight = true)
    cb!(snap); await flush();  // tick 2 must short-circuit before touching listPanes
    expect(listCalls).toBe(1);
    release(); await flush();
  });

  it("isolates a closePane failure: one zombie's close error doesn't abort the others or escape the tick", async () => {
    const link = (paneId: string, tabId: string, ws: string, sid: string): typeof board.tasks[0]["sessions"][0] => ({
      env: "work-local", paneId, tabId, tabLabel: "z", workspaceId: ws, workspaceLabel: "c", name: "z", cwdSnapshot: "/c", sessionId: sid,
    });
    const board: Board = {
      id: "b", label: "B", columns: [],
      tasks: [{ id: "t", title: "x", description: "", status: "todo", priority: null, createdAt: 1, updatedAt: 1,
        sessions: [link("w1:p2", "w1:t2", "w1", SID), link("w2:p3", "w2:t3", "w2", "dddddddd-1111-2222-3333-444444444444")] }],
      spawnPresets: [], defaultSpawnPresetId: null,
    };
    const closed: string[] = [];
    let clock = 0;
    let cb: ((s: Snapshot) => void) | null = null;
    const empty: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
    startZombieReaper({
      poller: { getSnapshot: () => empty, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
      storage: { getAllBoards: () => [board] },
      envs: [getEnv("work-local")],
      listPanes: () => Promise.resolve([
        { paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false },
        { paneId: "w2:p3", tabId: "w2:t3", workspaceId: "w2", hasAgent: false },
      ]),
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
      tasks: [{ id: "t", title: "x", description: "", status: "todo", priority: null,
        createdAt: 1, updatedAt: 1, sessions: [sess("w1:p2", "w1:t2", "w1", SID), sess("w2:p3", "w2:t3", "w2", SID2)] }],
      spawnPresets: [], defaultSpawnPresetId: null,
    };
    const empty: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
    const aLive: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [{
      env: "work-local", paneId: "w1:p2", status: "working", agent: "claude", cwd: "/c",
      tab: "z", workspace: "c", tabId: "w1:t2", workspaceId: "w1", sessionId: SID,
      recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null,
    }] };
    let snap: Snapshot = empty;
    let clock = 0;
    const closed: string[] = [];
    let cb: ((s: Snapshot) => void) | null = null;
    startZombieReaper({
      poller: { getSnapshot: () => snap, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
      storage: { getAllBoards: () => [board] },
      envs: [getEnv("work-local")],
      listPanes: () => Promise.resolve([
        { paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false },
        { paneId: "w2:p3", tabId: "w2:t3", workspaceId: "w2", hasAgent: false },
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
      listPanes: () => Promise.resolve([{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }]),
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
        panes: [{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }],
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
        listPanes: () => Promise.resolve([{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }]),
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
        recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null,
      }],
    };
    const h = harness({
      snapshot: live, boards: [boardWithLink()],
      panes: [{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }],
    });
    h.setClock(0); h.fire(); await flush();
    h.setClock(20_000); h.fire(); await flush();
    expect(h.closed).toEqual([]);
  });

  it("issues no herdr command at all when the link's pane is gone but its tab lingers", async () => {
    // Regression for the endless `pane close … pane_not_found` loop: the tab-only guard authorised a
    // close against a pane herdr had never heard of, once per tick, forever.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const h = harness({
        snapshot: { envs: { "work-local": { reachable: true } }, sessions: [] },
        boards: [boardWithLink()],                                   // link points at w1:p2
        panes: [{ paneId: "w1:pQ", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }], // tab alive, pane replaced
      });
      h.setClock(0); h.fire(); await flush();
      h.setClock(20_000); h.fire(); await flush();
      h.setClock(40_000); h.fire(); await flush();
      expect(h.closed).toEqual([]);
      expect(warn.mock.calls.flat().filter((a) => typeof a === "string" && a.includes("zombie-reaper"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT reap a pane running a non-Claude agent that pane list reports as free", async () => {
    // A bash-style agent (`herdr agent start <name> -- bash`) is indistinguishable from a free pane in
    // `pane list` — verified against a live herdr. The poller's agent-list index is what sees it, so
    // this pins occupancy authority on that index and not on PaneIdentity.hasAgent. It does NOT say
    // WHICH agent-list guard did the work: the stranger is present in every snapshot here, so the
    // pre-close re-read alone would also block the close. The pre-filter's own effect (an occupied
    // pane seeds no timer) is pinned by "seeds no grace timer while the agent-list index shows the
    // pane occupied" above.
    const h = harness({
      snapshot: { envs: { "work-local": { reachable: true } }, sessions: [{
        env: "work-local", paneId: "w1:p2", status: "unknown", agent: "", cwd: "/c",
        tab: "task-a", workspace: "c", tabId: "w1:t2", workspaceId: "w1", sessionId: null,
        recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null,
      }] },
      boards: [boardWithLink({ sessionId: SID })],                 // our own session S1 is gone
      panes: [{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }], // list says free
    });
    h.setClock(0); h.fire(); await flush();
    h.setClock(20_000); h.fire(); await flush();
    expect(h.closed).toEqual([]);
  });

  it("stops retrying a failing close after 3 attempts and re-ages the candidate instead of abandoning it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const snap: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
      let clock = 0;
      let attempts = 0;
      let cb: ((s: Snapshot) => void) | null = null;
      startZombieReaper({
        poller: { getSnapshot: () => snap, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
        storage: { getAllBoards: () => [boardWithLink()] },
        envs: [getEnv("work-local")],
        listPanes: () => Promise.resolve([{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }]),
        closePane: () => { attempts++; return Promise.reject(new Error("herdr unreachable")); },
        now: () => clock, graceMs: 20_000,
      });
      clock = 0; cb!(snap); await flush();                    // seed the timer
      for (const t of [20_000, 20_001, 20_002, 20_003, 20_004]) {
        clock = t; cb!(snap); await flush();
      }
      expect(attempts).toBe(3);                               // capped, not once per tick

      // The candidate is not abandoned: after a full grace it is eligible again. (This jump also
      // exceeds graceMs itself, so the tick-gap branch would re-seed even without the cap — the
      // attempts===3 assertion above is what isolates the cap's own behaviour.)
      clock = 60_000; cb!(snap); await flush();               // re-seeds
      clock = 80_000; cb!(snap); await flush();               // grace elapsed again
      expect(attempts).toBe(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("resets the failure count after a close succeeds, so the next run gets a full 3 attempts", async () => {
    // A weaker version of this test — fail once, succeed once, expect 2 — passes against the CURRENT
    // code, which has no counter at all, and so proves nothing. This sequence discriminates: with a
    // counter that survives success, attempt 4 would be the 3rd failure and trip the cap immediately,
    // giving 4 total attempts. With the reset, failures start over and three more are allowed: 6.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const snap: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
      let clock = 0;
      let attempts = 0;
      let cb: ((s: Snapshot) => void) | null = null;
      startZombieReaper({
        poller: { getSnapshot: () => snap, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
        storage: { getAllBoards: () => [boardWithLink()] },
        envs: [getEnv("work-local")],
        listPanes: () => Promise.resolve([{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }]),
        closePane: () => {
          attempts++;
          return attempts === 3 ? Promise.resolve() : Promise.reject(new Error("transient"));
        },
        now: () => clock, graceMs: 20_000,
      });
      clock = 0; cb!(snap); await flush();                    // seed
      for (const t of [20_000, 20_001, 20_002, 20_003, 20_004, 20_005, 20_006]) {
        clock = t; cb!(snap); await flush();
      }
      // 1 fail, 2 fail, 3 SUCCESS (count reset), 4 fail, 5 fail, 6 fail → cap → timer dropped, 7th tick
      // finds a re-seeded timer and does not attempt.
      expect(attempts).toBe(6);
    } finally {
      warn.mockRestore();
    }
  });

  it("restarts the close-attempt count for a new grace window (window stamp at the increment)", async () => {
    // Pins the reset mechanism: `failures` entries are stamped with the window they were booked under
    // (`firstSeenAt`), and the increment only builds on a stamp matching the CURRENT window. A count
    // from an earlier window is therefore never read again, with no pruning pass involved.
    // The link's own episode ends mid-window (a different session takes over the pane), then a
    // genuinely new episode starts later. The new window gets a full 3 attempts, not 3 minus whatever
    // had already failed before the break.
    const S2 = "ffffffff-1111-2222-3333-444444444444";
    const empty: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
    const live: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [{
      env: "work-local", paneId: "w1:p2", status: "idle", agent: "claude", cwd: "/c",
      tab: "task-a", workspace: "c", tabId: "w1:t2", workspaceId: "w1", sessionId: S2,
      recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null,
    }] };
    let snap: Snapshot = empty;
    let clock = 0;
    let attempts = 0;
    let cb: ((s: Snapshot) => void) | null = null;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      startZombieReaper({
        poller: { getSnapshot: () => snap, onSnapshot: (fn) => { cb = fn; return () => void 0; } },
        storage: { getAllBoards: () => [boardWithLink()] },
        envs: [getEnv("work-local")],
        listPanes: () => Promise.resolve([{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false }]),
        closePane: () => { attempts++; return Promise.reject(new Error("herdr unreachable")); },
        now: () => clock, graceMs: 20_000,
      });
      clock = 0; cb!(snap); await flush();                       // seed
      clock = 20_000; cb!(snap); await flush();                  // attempt 1, fails (count 1)
      snap = live; clock = 20_001; cb!(snap); await flush();     // a different session takes the pane: episode ends
      snap = empty; clock = 20_002; cb!(snap); await flush();    // pane free again: a genuinely new episode
      for (const t of [40_002, 40_003, 40_004, 40_005]) {
        clock = t; cb!(snap); await flush();
      }
      expect(attempts).toBe(4);                                  // 1 from window 1, a full 3 from window 2
    } finally {
      warn.mockRestore();
    }
  });
});
