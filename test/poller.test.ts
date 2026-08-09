import type { AttentionMap, SessionRow, Snapshot, StatuslineData } from "@shared/schema";
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";

import { CLAUDE_REGISTRY_POLL_MS } from "../config.ts";
import type { HerdrEnv } from "../environments.ts";
import type { AttentionStore } from "../server/attention-store.ts";
import { createPoller, type ListFn, type RecapFn, type StatuslineFn } from "../server/poller.ts";
import { RegistryRecordSchema, type RegistryRead } from "../server/session-registry.ts";

const A: HerdrEnv = { id: "a", label: "A", kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {} };
const B: HerdrEnv = { id: "b", label: "B", kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {} };
const row = (env: string, paneId: string): SessionRow => ({
  env, paneId, status: "working", agent: "claude", cwd: "/x", tab: "t", workspace: "w",
  sessionId: null, recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null,
});

describe("createPoller", () => {
  it("aggregates sessions from all envs and marks them reachable", async () => {
    const list: ListFn = (e) => Promise.resolve([row(e.id, `${e.id}-1`)]);
    const p = createPoller({ envs: [A, B], list });
    await p.pollOnce();
    const snap = p.getSnapshot();
    expect(snap.sessions.map((s) => s.paneId).sort()).toEqual(["a-1", "b-1"]);
    expect(snap.envs.a).toEqual({ reachable: true, kind: "local", label: "A" });
  });

  it("refreshEnv re-lists only the named env, and ignores an unknown id", async () => {
    const seen: string[] = [];
    const list: ListFn = (e) => { seen.push(e.id); return Promise.resolve([row(e.id, `${e.id}-1`)]); };
    const p = createPoller({ envs: [A, B], list });
    await p.refreshEnv("a");
    expect(seen).toEqual(["a"]);
    expect(p.getSnapshot().sessions.map((s) => s.paneId)).toEqual(["a-1"]);
    // An id no environment claims must resolve quietly rather than throw or poll everything —
    // the whoami miss path calls this with whatever env ids the config happens to hold.
    await p.refreshEnv("nope");
    expect(seen).toEqual(["a"]);
  });

  it("refreshEnv shares the interval's guard, so an overlapping call collapses instead of racing", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const list: ListFn = async (e) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await gate;
      inFlight -= 1;
      return [row(e.id, `${e.id}-1`)];
    };
    const p = createPoller({ envs: [A], list });
    const first = p.refreshEnv("a");
    const second = p.refreshEnv("a"); // lands while the first is still awaiting the gate
    release();
    await Promise.all([first, second]);
    expect(maxConcurrent).toBe(1);
  });

  it("reports env kind in the snapshot (local and remote)", async () => {
    const remote: HerdrEnv = { id: "r", label: "R", kind: "remote", sshHost: "h", socket: "~/s.sock", herdrBin: "~/herdr", claudeConfigDirs: [], spawnCommand: "claude", repos: {} };
    const list: ListFn = () => Promise.resolve([]);
    const p = createPoller({ envs: [A, remote], list });
    await p.pollOnce();
    const snap = p.getSnapshot();
    expect(snap.envs.a?.kind).toBe("local");
    expect(snap.envs.r?.kind).toBe("remote");
  });

  it("marks a failing env unreachable and keeps last-good rows", async () => {
    let failB = false;
    const list: ListFn = (e) => {
      if (e.id === "b" && failB) throw new Error("ssh timeout");
      return Promise.resolve([row(e.id, `${e.id}-1`)]);
    };
    const p = createPoller({ envs: [A, B], list });
    await p.pollOnce();
    failB = true;
    await p.pollOnce();
    const snap = p.getSnapshot();
    expect(snap.envs.b?.reachable).toBe(false);
    expect(snap.envs.b?.error).toContain("ssh timeout");
    expect(snap.sessions.some((s) => s.paneId === "b-1")).toBe(true);
  });

  it("notifies subscribers on each poll", async () => {
    const list: ListFn = (e) => Promise.resolve([row(e.id, `${e.id}-1`)]);
    const p = createPoller({ envs: [A], list });
    const cb = vi.fn();
    p.onSnapshot(cb);
    await p.pollOnce();
    expect(cb).toHaveBeenCalled();
  });
});

describe("createPoller tab rename", () => {
  it("renames a tab when the canonical pane has a user-set name differing from the label", async () => {
    const env = A; // existing local env fixture in this file
    const rows = [{
      env: env.id, paneId: "p1", status: "working", agent: "claude", cwd: "/x",
      tab: "1", workspace: "ws", tabId: "t1", workspaceId: "w1", sessionId: "11111111-2222-3333-4444-555555555555",
      recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null,
    }];
    const statusline: StatuslineFn = () => Promise.resolve({
      data: {
        v: 1, captured_at: 1, session_id: "11111111-2222-3333-4444-555555555555",
        session_name: "renamed-by-user", name_source: "user",
        account: null, model: null, model_id: null,
        ctx: { pct: null, tokens: null, window: null },
        cost: { usd: null, lines_added: null, lines_removed: null },
        rate: { five_hour: null, seven_day: null },
        effort: null, thinking: null, cc_version: null,
      },
      status: "ok",
    });
    const calls: { tabId: string; label: string }[] = [];
    const p = createPoller({
      envs: [env],
      list: () => Promise.resolve(rows),
      recap: () => Promise.resolve({ recap: null, status: "no-summary" }),
      statusline,
      tabRename: (_e, tabId, label) => { calls.push({ tabId, label }); return Promise.resolve(); },
      tabRenameEnabled: true,
    });
    await p.pollOnce();          // populate perEnv rows
    await p.runClaudeSweepOnce(); // capture statusline + apply renames
    expect(calls).toEqual([{ tabId: "t1", label: "renamed-by-user" }]);
  });
});

const VALID_UUID = "a13ad559-8e59-4b98-b420-2746ef0b94d8";
const OTHER_UUID = "b24be66a-9f6a-5ca9-c531-3857fc1ca5e9";

function rowWithSession(env: string, paneId: string, sessionId: string): SessionRow {
  return { env, paneId, status: "working", agent: "claude", cwd: "/x", tab: "t", workspace: "w",
    sessionId, recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null };
}

describe("createPoller — recap sweep", () => {
  it("recapFn is called for each pane with a sessionId", async () => {
    const recap: RecapFn = vi.fn(() => Promise.resolve({ recap: "summary", status: "ok" as const }));
    const list: ListFn = (e) => Promise.resolve([rowWithSession(e.id, `${e.id}-1`, VALID_UUID)]);
    const p = createPoller({ envs: [A], list, recap, recapIntervalMs: 99999 });
    await p.pollOnce();
    // Manually trigger the sweep by starting and stopping (guardedInterval fires immediately)
    // Instead, test via the recapFn being injected and the snapshot merging
    // We test sweep behavior via pollOnce + rebuild by directly calling the recap path
    // Since guardedInterval fires immediately on start(), we use start/stop pattern:
    p.start();
    await new Promise((r) => setTimeout(r, 50));
    p.stop();
    expect(recap).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), VALID_UUID);
  });

  it("recap from cache is merged into SessionRow when sessionId matches", async () => {
    const recap: RecapFn = vi.fn(() => Promise.resolve({ recap: "latest recap", status: "ok" as const }));
    const list: ListFn = (e) => Promise.resolve([rowWithSession(e.id, `${e.id}-1`, VALID_UUID)]);
    const p = createPoller({ envs: [A], list, recap, recapIntervalMs: 99999 });
    await p.pollOnce();
    p.start();
    await new Promise((r) => setTimeout(r, 50));
    p.stop();
    const snap = p.getSnapshot();
    const row = snap.sessions[0];
    expect(row?.recap).toBe("latest recap");
    expect(row?.recapStatus).toBe("ok");
    expect(typeof row?.recapAt).toBe("number");
  });

  it("recap is NOT merged when sessionId differs (stale cache)", async () => {
    let sessionId = VALID_UUID;
    const recap: RecapFn = vi.fn(() => Promise.resolve({ recap: "stale", status: "ok" as const }));
    const listFn: ListFn = (e) => Promise.resolve([rowWithSession(e.id, `${e.id}-1`, sessionId)]);
    const p = createPoller({ envs: [A], list: listFn, recap, recapIntervalMs: 99999 });

    // Step 1: Initial poll with VALID_UUID
    await p.pollOnce();

    // Step 2: Manually trigger recap sweep by start/stop to cache the recap for VALID_UUID
    p.start();
    await new Promise((r) => setTimeout(r, 50));
    p.stop();
    expect(recap).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), VALID_UUID);

    // Step 3: Change the sessionId to OTHER_UUID for the next poll
    sessionId = OTHER_UUID;

    // Step 4: Poll again — row now has OTHER_UUID, but cache still has VALID_UUID
    // The rebuild() guard should NOT merge because sessionIds don't match
    await p.pollOnce();
    const snap = p.getSnapshot();
    expect(snap.sessions[0]?.recap).toBeNull();
  });

  it("panes without sessionId are skipped by the recap sweep", async () => {
    const recap: RecapFn = vi.fn(() => Promise.resolve({ recap: "r", status: "ok" as const }));
    const list: ListFn = (e) => Promise.resolve([row(e.id, `${e.id}-1`)]);
    const p = createPoller({ envs: [A], list, recap, recapIntervalMs: 99999 });
    await p.pollOnce();
    p.start();
    await new Promise((r) => setTimeout(r, 50));
    p.stop();
    expect(recap).not.toHaveBeenCalled();
  });

  it("does NOT log the recap_sweep summary on a clean sweep (errors == 0)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recap: RecapFn = () => Promise.resolve({ recap: "summary", status: "ok" as const });
    const list: ListFn = (e) => Promise.resolve([rowWithSession(e.id, `${e.id}-1`, VALID_UUID)]);
    const p = createPoller({ envs: [A], list, recap, recapIntervalMs: 99999 });
    await p.pollOnce();
    p.start();
    await new Promise((r) => setTimeout(r, 50));
    p.stop();
    const sweepLogged = warnSpy.mock.calls.some((args) => typeof args[0] === "string" && args[0].includes("recap_sweep"));
    warnSpy.mockRestore();
    expect(sweepLogged).toBe(false);
  });

  it("logs the recap_sweep summary when a recap read fails (errors > 0)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recap: RecapFn = () => Promise.resolve({ recap: null, status: "read-error" as const });
    const list: ListFn = (e) => Promise.resolve([rowWithSession(e.id, `${e.id}-1`, VALID_UUID)]);
    const p = createPoller({ envs: [A], list, recap, recapIntervalMs: 99999 });
    await p.pollOnce();
    p.start();
    await new Promise((r) => setTimeout(r, 50));
    p.stop();
    const sweepLogged = warnSpy.mock.calls.some(
      (args) => typeof args[0] === "string" && args[0].includes("recap_sweep") && args[0].includes('"errors":1'),
    );
    warnSpy.mockRestore();
    expect(sweepLogged).toBe(true);
  });
});

describe("createPoller — statusline sweep", () => {
  it("merges statusline data onto session rows via the sweep", async () => {
    const sl: StatuslineData = {
      v: 1, captured_at: 100, session_id: "sid-1", session_name: null, name_source: null,
      account: { uuid: "u1", email: "a@b.c", org: "O", tier: "t" },
      model: "Opus", model_id: null, ctx: { pct: 42, tokens: null, window: null },
      cost: { usd: null, lines_added: null, lines_removed: null },
      rate: { five_hour: null, seven_day: null }, effort: null, thinking: null, cc_version: null,
    };
    const statusline: StatuslineFn = () => Promise.resolve({ data: sl, status: "ok" as const });
    const recap: RecapFn = () => Promise.resolve({ recap: null, status: "not-found" as const });
    const list: ListFn = (e) => Promise.resolve([rowWithSession(e.id, `${e.id}-1`, "sid-1")]);
    const poller = createPoller({ envs: [A], list, recap, statusline, recapIntervalMs: 99999 });
    await poller.pollOnce();
    await poller.runClaudeSweepOnce();
    const row = poller.getSnapshot().sessions[0];
    expect(row?.statusline?.ctx.pct).toBe(42);
    expect(row?.statuslineStatus).toBe("ok");
  });
});

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (): void => {};
const E: HerdrEnv = { id: "e1", label: "E1", kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {} };
const mkRow = (status: string): SessionRow => ({
  env: "e1", paneId: "p", status, agent: "claude", cwd: "/x", tab: "t", workspace: "w",
  sessionId: null, recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null,
});
const NOOP_MAP: AttentionMap = {};

describe("createPoller — attention detection", () => {
  it("runs detectTransitions and feeds the store a blocked event on the transition tick", async () => {
    const applied: { events: number; cleared: number }[] = [];
    const store: AttentionStore = { init: noop, pruneEnv: noop, getMap: () => NOOP_MAP, apply: (_e, ev, cl) => { applied.push({ events: ev.length, cleared: cl.length }); } };
    let call = 0;
    const list: ListFn = () => Promise.resolve([mkRow(call++ === 0 ? "working" : "blocked")]);
    const poller = createPoller({ envs: [E], list, minWorkMs: 600_000, attention: store });
    await poller.pollOnce(); // tick 1: seed working
    await poller.pollOnce(); // tick 2: working → blocked
    expect(applied.at(-1)).toMatchObject({ events: 1 }); // the real detect→apply signal
  });

  it("skips detection on a failed tick (unreachable env untouched)", async () => {
    const applied: number[] = [];
    const store: AttentionStore = { init: noop, pruneEnv: noop, getMap: () => NOOP_MAP, apply: () => { applied.push(1); } };
    const list: ListFn = () => { throw new Error("unreachable"); };
    const poller = createPoller({ envs: [E], list, attention: store });
    await poller.pollOnce();
    expect(applied).toEqual([]); // apply sits after `await list` inside the try → never runs on a failed tick
  });

  it("prunes an env only on its first successful tick", async () => {
    const prunes: number[] = [];
    const store: AttentionStore = { init: noop, getMap: () => NOOP_MAP, apply: noop, pruneEnv: () => { prunes.push(1); } };
    const list: ListFn = () => Promise.resolve([]);
    const poller = createPoller({ envs: [E], list, attention: store });
    await poller.pollOnce();
    await poller.pollOnce();
    expect(prunes).toEqual([1]); // once, not per tick
  });
});

describe("createPoller initial sweep kick", () => {
  const SID = "11111111-2222-3333-4444-555555555555";
  const liveRow: SessionRow = {
    env: A.id, paneId: "p1", status: "working", agent: "claude", cwd: "/x",
    tab: "1", workspace: "ws", tabId: "t1", workspaceId: "w1", sessionId: SID,
    recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null,
  };
  const userStatusline: StatuslineFn = () => Promise.resolve({
    data: {
      v: 1, captured_at: 1, session_id: SID, session_name: "renamed-by-user", name_source: "user",
      account: null, model: null, model_id: null,
      ctx: { pct: null, tokens: null, window: null },
      cost: { usd: null, lines_added: null, lines_removed: null },
      rate: { five_hour: null, seven_day: null },
      effort: null, thinking: null, cc_version: null,
    },
    status: "ok",
  });

  it("kicks the first sweep after initialSweepDelayMs, not a full recap interval", async () => {
    vi.useFakeTimers();
    try {
      const calls: { tabId: string; label: string }[] = [];
      const p = createPoller({
        envs: [A],
        list: () => Promise.resolve([liveRow]),
        recap: () => Promise.resolve({ recap: null, status: "no-summary" }),
        statusline: userStatusline,
        tabRename: (_e, tabId, label) => { calls.push({ tabId, label }); return Promise.resolve(); },
        tabRenameEnabled: true,
        initialSweepDelayMs: 5000,
        recapIntervalMs: 60000,
        intervalMs: 30000,
      });
      p.start();
      await vi.advanceTimersByTimeAsync(4999);
      expect(calls).toEqual([]); // the racing t=0 sweep no-ops; the delayed kick has not fired yet
      await vi.advanceTimersByTimeAsync(1);
      // renamed at ~5s (well before the 60s recap interval); name_source null = user-set (post-fix)
      expect(calls).toEqual([{ tabId: "t1", label: "renamed-by-user" }]);
      p.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Only the install-drift line, so an unrelated console.warn in the same run cannot satisfy an assertion.
function driftWarnings(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes("report no Claude session id"));
}

describe("createPoller — install-drift warning", () => {
  it("names both causes when panes report no Claude session, rather than asserting the integration is missing", async () => {
    // The old warning asserted "integration likely not installed" and prescribed
    // `herdr integration install claude`. On a box where the integration IS installed that command
    // changes nothing and the operator is sent down a dead end — because a pane also reports no
    // session id whenever the hook exited early, which it does unless HERDR_ENV, HERDR_SOCKET_PATH
    // and HERDR_PANE_ID are all set in that pane, i.e. for any pane not started inside a herdr
    // context. The message must therefore describe the observation and name both branches.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const list: ListFn = (e) => Promise.resolve([row(e.id, `${e.id}-1`)]); // sessionId null, cwd set
      const p = createPoller({ envs: [A], list });
      await p.pollOnce();
      await p.runClaudeSweepOnce();
      // Match the SPECIFIC call, not every console.warn joined together — otherwise any unrelated
      // warning mentioning HERDR_PANE_ID would satisfy this.
      const msg = driftWarnings(warn)[0] ?? "";
      expect(msg).toContain("herdr integration install claude"); // still actionable for that cause
      expect(msg).toContain("HERDR_PANE_ID"); // ...but the other cause is named too
      expect(msg).not.toContain("likely not installed"); // no asserted cause
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent when every pane reports a Claude session id", async () => {
    // The rewrite made the message a paragraph, so a false positive is now materially noisier than the
    // one-liner it replaced. Neither guard in the condition was covered before.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const list: ListFn = (e) => Promise.resolve([{ ...row(e.id, `${e.id}-1`), sessionId: "11111111-2222-3333-4444-555555555555" }]);
      const p = createPoller({ envs: [A], list });
      await p.pollOnce();
      await p.runClaudeSweepOnce();
      expect(driftWarnings(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns once per env, not once per sweep", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const list: ListFn = (e) => Promise.resolve([row(e.id, `${e.id}-1`)]);
      const p = createPoller({ envs: [A], list });
      await p.pollOnce();
      await p.runClaudeSweepOnce();
      await p.runClaudeSweepOnce();
      await p.runClaudeSweepOnce();
      expect(driftWarnings(warn)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

const reads = (read: RegistryRead) => () => Promise.resolve(read);
const ok = (records: RegistryRead["records"]): RegistryRead => ({ records, status: "ok", truncated: false });

describe("createPoller — registry join", () => {
  it("applyRegistry patches the matching row and pushes a snapshot", async () => {
    const p = createPoller({ envs: [A], list: () => Promise.resolve([rowWithSession(A.id, "p1", VALID_UUID)]) });
    await p.pollOnce();
    const seen: Snapshot[] = [];
    p.onSnapshot((s) => seen.push(s));
    p.applyRegistry(A, ok([{ sessionId: VALID_UUID, status: "waiting", waitingFor: "input needed", bridgeSessionId: "session_01X" }]));
    // Without the rebuild+notify inside applyRegistry the record would land in a cache with no path
    // out: SSE frames come only from the poller's snapshot subscribers.
    const patched = seen.at(-1)?.sessions.find((r) => r.paneId === "p1");
    expect(patched?.claudeStatus).toBe("waiting");
    expect(patched?.waitingFor).toBe("input needed");
    expect(patched?.remoteControl).toBe(true);
    expect(patched?.registryStatus).toBe("ok");
  });

  it("drops a record whose sessionId matches no live row", async () => {
    const p = createPoller({ envs: [A], list: () => Promise.resolve([rowWithSession(A.id, "p1", VALID_UUID)]) });
    await p.pollOnce();
    p.applyRegistry(A, ok([{ sessionId: OTHER_UUID, status: "busy" }]));
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBeNull();
    // "we looked and this session was not there" — NOT the null of "we have not looked yet".
    expect(p.getSnapshot().sessions[0]?.registryStatus).toBe("not-found");
  });

  it("never applies a cached record to a pane that has since changed session", async () => {
    let sid = VALID_UUID;
    const p = createPoller({ envs: [A], list: () => Promise.resolve([rowWithSession(A.id, "p1", sid)]) });
    await p.pollOnce();
    p.applyRegistry(A, ok([{ sessionId: VALID_UUID, status: "waiting" }]));
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBe("waiting");
    sid = OTHER_UUID; // herdr recycled the pane onto a different session
    await p.refreshEnv(A.id);
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBeNull();
    // And the stale entry's STATUS must not leak either — the new session has not been read yet.
    expect(p.getSnapshot().sessions[0]?.registryStatus).toBeNull();
  });

  // The window between pane creation and Claude registering — the board must say "starting", not
  // "idle", and remoteControl must be null (unknown) rather than false.
  it("marks a row with no sessionId as no-session-ref, not as idle", async () => {
    const p = createPoller({ envs: [A], list: () => Promise.resolve([row(A.id, "p1")]) });
    await p.pollOnce();
    const r = p.getSnapshot().sessions[0];
    expect(r?.registryStatus).toBe("no-session-ref");
    expect(r?.claudeStatus).toBeNull();
    expect(r?.remoteControl).toBeNull();
  });

  // "the sweep has not run for this pane yet" is a sixth distinct state, and the reason a bare
  // `claudeStatus: null` could not have carried this information on its own.
  it("leaves registryStatus null for a row with a sessionId that has never been read", async () => {
    const p = createPoller({ envs: [A], list: () => Promise.resolve([rowWithSession(A.id, "p1", VALID_UUID)]) });
    await p.pollOnce();
    expect(p.getSnapshot().sessions[0]?.registryStatus).toBeNull();
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBeNull();
  });

  it("applyRegistry on an environment with no polled rows is a no-op, not a throw", async () => {
    const p = createPoller({ envs: [A], list: () => Promise.resolve([]) });
    await p.pollOnce();
    const seen: Snapshot[] = [];
    p.onSnapshot((s) => seen.push(s));
    p.applyRegistry(A, ok([{ sessionId: VALID_UUID, status: "busy" }]));
    expect(seen).toEqual([]);
  });

  // The registry cache is keyed by pane and must be pruned with the others, or a closed pane's record
  // outlives it for the life of the process.
  it("prunes the registry cache when a pane disappears", async () => {
    let rows = [rowWithSession(A.id, "p1", VALID_UUID)];
    const p = createPoller({
      envs: [A],
      list: () => Promise.resolve(rows),
      recap: () => Promise.resolve({ recap: null, status: "not-found" as const }),
      statusline: () => Promise.resolve({ data: null, status: "not-found" as const }),
    });
    await p.pollOnce();
    p.applyRegistry(A, ok([{ sessionId: VALID_UUID, status: "busy" }]));
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBe("busy");
    rows = []; // pane closed
    await p.refreshEnv(A.id);
    await p.runClaudeSweepOnce(); // prunes
    rows = [rowWithSession(A.id, "p1", VALID_UUID)]; // herdr hands the same pane id back out
    await p.refreshEnv(A.id);
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBeNull();
  });
});

// THE SWEEP READS REMOTE ENVIRONMENTS ONLY — local ones are the interval's job, and a second reader
// for one environment is exactly what the one-writer property forbids. So every test in this block
// drives a REMOTE env; `A` is kind: "local".
//
// `recap` and `statusline` MUST be stubbed here. createPoller defaults them to the real readRecap /
// readStatusline, and on a remote env those open SSH connections — the suite would hang on a real
// network. The rows below carry sessionIds, so the sweep reaches them.
const R: HerdrEnv = {
  id: "r", label: "R", kind: "remote", sshHost: "h", socket: "~/s.sock", herdrBin: "~/herdr",
  claudeConfigDirs: ["/home/u/.claude"], spawnCommand: "claude", repos: {},
};
const sweepPoller = (over: {
  list: ListFn;
  readRegistry: (env: HerdrEnv) => Promise<RegistryRead>;
}) => createPoller({
  envs: [R],
  recap: () => Promise.resolve({ recap: null, status: "not-found" as const }),
  statusline: () => Promise.resolve({ data: null, status: "not-found" as const }),
  ...over,
});

describe("createPoller — the sweep is the backstop", () => {
  it("reads the registry once per environment and merges it", async () => {
    let calls = 0;
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID), rowWithSession(R.id, "p2", OTHER_UUID)]),
      readRegistry: () => { calls++; return Promise.resolve(ok([{ sessionId: VALID_UUID, status: "busy" }])); },
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    expect(calls).toBe(1); // ONE round trip per env, not one per session
    const rows = p.getSnapshot().sessions;
    expect(rows.find((r) => r.paneId === "p1")?.claudeStatus).toBe("busy");
    // A live row with a sessionId the read did not return: the read WORKED, this session just is not
    // in it. That is not-found, and it must not read as "idle" or as an error.
    expect(rows.find((r) => r.paneId === "p2")?.registryStatus).toBe("not-found");
    expect(rows.find((r) => r.paneId === "p2")?.claudeStatus).toBeNull();
  });

  // The other half of "remote only": a LOCAL environment must not be read by the sweep at all, or it
  // has two writers and absence stops being authoritative for either of them.
  it("does not read the registry for a local environment", async () => {
    let calls = 0;
    const p = createPoller({
      envs: [A],
      list: () => Promise.resolve([rowWithSession(A.id, "p1", VALID_UUID)]),
      recap: () => Promise.resolve({ recap: null, status: "not-found" as const }),
      statusline: () => Promise.resolve({ data: null, status: "not-found" as const }),
      readRegistry: () => { calls++; return Promise.resolve(ok([])); },
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    expect(calls).toBe(0);
  });

  it("propagates a read failure to the row instead of blanking it silently", async () => {
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: reads({ records: [], status: "read-error", truncated: false }),
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    expect(p.getSnapshot().sessions[0]?.registryStatus).toBe("read-error");
  });

  it("propagates no-config-dirs so the card can fall back to herdr's status", async () => {
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: reads({ records: [], status: "no-config-dirs", truncated: false }),
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    expect(p.getSnapshot().sessions[0]?.registryStatus).toBe("no-config-dirs");
  });

  // A reader that THROWS must not take the rest of the sweep down with it — recap, statusline and the
  // tab renames all run in the same pass.
  it("survives a reader that rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: () => Promise.reject(new Error("boom")),
    });
    await p.pollOnce();
    await expect(p.runClaudeSweepOnce()).resolves.toBeUndefined();
    expect(p.getSnapshot().sessions[0]?.registryStatus).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("boom"))).toBe(true);
    warn.mockRestore();
  });

  // ONE WRITER PER ENVIRONMENT, and both writers do FULL reads, so a later read simply supersedes an
  // earlier one. These two tests pin the plain-supersede semantics.
  it("lets a later read supersede an earlier one, regardless of updatedAt", async () => {
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: reads(ok([{ sessionId: VALID_UUID, status: "busy", updatedAt: 100 }])),
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBe("busy");
    // A later read wins even though its updatedAt is LOWER — the bridge writer stamps no updatedAt, so
    // an RC transition legitimately arrives with an equal or stale one. Ordering by updatedAt here is
    // what would have silently frozen the RC badge.
    p.applyRegistry(R, ok([{ sessionId: VALID_UUID, status: "waiting", updatedAt: 50 }]));
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBe("waiting");
  });

  it("treats an RC transition with an unchanged updatedAt as a real change", async () => {
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: reads(ok([{ sessionId: VALID_UUID, status: "idle", updatedAt: 100 }])),
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    expect(p.getSnapshot().sessions[0]?.remoteControl).toBe(false);
    // Same updatedAt, bridgeSessionId appears: the exact shape the bridge writer produces.
    p.applyRegistry(R, ok([{ sessionId: VALID_UUID, status: "idle", updatedAt: 100, bridgeSessionId: "b-1" }]));
    expect(p.getSnapshot().sessions[0]?.remoteControl).toBe(true);
  });

  // The freeze this replaced: an earlier draft made "absence never overwrites a record" unconditional,
  // so one successful read pinned a pane forever. That is the exact frozen-row bug the sweep exists to
  // prevent, reintroduced one layer down.
  it("lets the sweep clear a record the registry no longer holds", async () => {
    let holdsRecord = true;
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: () => Promise.resolve(holdsRecord
        ? ok([{ sessionId: VALID_UUID, status: "busy", updatedAt: 100 }])
        : ok([])),
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBe("busy");
    holdsRecord = false;
    await p.runClaudeSweepOnce();
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBeNull();
    expect(p.getSnapshot().sessions[0]?.registryStatus).toBe("not-found");
  });

  // Absence is ALWAYS authoritative, because every reader does a full directory read.
  it("clears a record when a full read no longer holds it", async () => {
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: reads(ok([{ sessionId: VALID_UUID, status: "busy", updatedAt: 100 }])),
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBe("busy");
    p.applyRegistry(R, ok([]));
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBeNull();
    expect(p.getSnapshot().sessions[0]?.registryStatus).toBe("not-found");
  });

  // A FAILED read is not an empty one. `read-error` must never be mistaken for "the session is gone",
  // or a momentary EACCES would blank the board.
  it("leaves the previous record alone when the read failed", async () => {
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: reads(ok([{ sessionId: VALID_UUID, status: "busy", updatedAt: 100 }])),
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    p.applyRegistry(R, { records: [], status: "read-error", truncated: false });
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBe("busy");
    expect(p.getSnapshot().sessions[0]?.registryStatus).toBe("read-error");
  });

  // And it recovers: the failure must not be sticky either.
  it("returns to ok once a later read succeeds", async () => {
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: reads(ok([{ sessionId: VALID_UUID, status: "busy", updatedAt: 100 }])),
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    p.applyRegistry(R, { records: [], status: "read-error", truncated: false });
    expect(p.getSnapshot().sessions[0]?.registryStatus).toBe("read-error");
    p.applyRegistry(R, ok([{ sessionId: VALID_UUID, status: "idle", updatedAt: 200 }]));
    expect(p.getSnapshot().sessions[0]?.registryStatus).toBe("ok");
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBe("idle");
  });

  // THE test that makes a sub-minute interval affordable. Without it every tick rebuilds the whole
  // session array and pushes a full snapshot to every SSE subscriber, forever, on a fleet that barely
  // changes. A flush's cost scales with the size of the BOARD, not the size of the change.
  it("does not broadcast when a read changes nothing", async () => {
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: reads(ok([{ sessionId: VALID_UUID, status: "idle", updatedAt: 300 }])),
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    const seen: Snapshot[] = [];
    p.onSnapshot((s) => seen.push(s));
    // Field-for-field equal to what the cache already holds — the shape of almost every tick. Note the
    // record is a NEW object every read, so the comparison must be on content, not identity.
    p.applyRegistry(R, ok([{ sessionId: VALID_UUID, status: "idle", updatedAt: 300 }]));
    expect(seen).toEqual([]);
    // A real change does broadcast, exactly once.
    p.applyRegistry(R, ok([{ sessionId: VALID_UUID, status: "busy", updatedAt: 400 }]));
    expect(seen).toHaveLength(1);
  });

  // The registry omits a key before the first RC connect and writes a literal null on every disconnect
  // afterwards. Those are the same state, so the transition between them must not broadcast — without
  // the `?? null` normalisation the first read after a session's very first connect fires twice.
  it("treats an absent optional field and a literal null as the same state", async () => {
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: reads(ok([{ sessionId: VALID_UUID, status: "idle", updatedAt: 300 }])),
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    const seen: Snapshot[] = [];
    p.onSnapshot((s) => seen.push(s));
    p.applyRegistry(R, ok([{ sessionId: VALID_UUID, status: "idle", updatedAt: 300, bridgeSessionId: null, waitingFor: null, name: null }]));
    expect(seen).toEqual([]);
  });

  // A permanent condition logged every pass is a log flood that trains the operator to ignore the
  // file. `bad-schema` above all must still be SAID once — it is the drift detector, and a detector
  // nothing reports is not a detector.
  it("logs a degraded read once per environment, not once per sweep", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: reads({ records: [], status: "bad-schema", truncated: false }),
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    await p.runClaudeSweepOnce();
    await p.runClaudeSweepOnce();
    const degraded = warn.mock.calls.filter((c) => String(c[0]).includes("registry read degraded"));
    expect(degraded).toHaveLength(1);
    expect(String(degraded[0]?.[0])).toContain("bad-schema");
    warn.mockRestore();
  });

  // no-config-dirs is the DEFAULT on every remote environment, so warning on it would fire once per
  // process on a completely healthy fleet.
  it("does not log a degraded read for no-config-dirs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: reads({ records: [], status: "no-config-dirs", truncated: false }),
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("registry read degraded"))).toEqual([]);
    warn.mockRestore();
  });

  it("warns once when a read was truncated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: reads({ records: [{ sessionId: VALID_UUID, status: "idle" }], status: "ok", truncated: true }),
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    await p.runClaudeSweepOnce();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("truncated"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("does not warn about truncation on an untruncated read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = sweepPoller({
      list: () => Promise.resolve([rowWithSession(R.id, "p1", VALID_UUID)]),
      readRegistry: reads(ok([{ sessionId: VALID_UUID, status: "idle" }])),
    });
    await p.pollOnce();
    await p.runClaudeSweepOnce();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("truncated"))).toEqual([]);
    warn.mockRestore();
  });
});

describe("createPoller — the local registry interval", () => {
  const tick = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(CLAUDE_REGISTRY_POLL_MS);
  };
  // start() fires ONE immediate sweep that is not parked by recapIntervalMs, and for a remote env that
  // sweep does its own registry read. Draining it here is what lets the assertions below be about the
  // INTERVAL's reads rather than about the sweep's.
  const settleStart = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

  it("reads each local environment once per tick and never a remote one", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const p = createPoller({
      envs: [A, R],
      list: (e) => Promise.resolve([rowWithSession(e.id, "p1", VALID_UUID)]),
      recap: () => Promise.resolve({ recap: null, status: "not-found" as const }),
      statusline: () => Promise.resolve({ data: null, status: "not-found" as const }),
      readRegistry: (e) => { seen.push(e.id); return Promise.resolve(ok([{ sessionId: VALID_UUID, status: "busy" }])); },
      // Park the recurring sweep far away so only the interval fires after settleStart.
      recapIntervalMs: 999_999, initialSweepDelayMs: 999_999,
    });
    await p.pollOnce();
    p.start();
    await settleStart();
    const afterStart = seen.length;
    await tick();
    p.stop();
    vi.useRealTimers();
    // The LOCAL env only. A remote read on the interval would be a second writer for that environment.
    expect(seen.slice(afterStart)).toEqual(["a"]);
    expect(p.getSnapshot().sessions.find((r) => r.env === "a")?.claudeStatus).toBe("busy");
  });

  // The per-directory bug this replaced: applyRegistry clears any session the read did not return, so
  // it must be handed a read covering ALL of an environment's claudeConfigDirs. A per-dir loop made
  // each dir's read clear the other dirs' sessions, flapping every row twice a tick.
  it("hands applyRegistry one read per environment, not one per config dir", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const multiDir: HerdrEnv = { ...A, claudeConfigDirs: ["/one", "/two", "/three"] };
    const p = createPoller({
      envs: [multiDir],
      list: () => Promise.resolve([rowWithSession(multiDir.id, "p1", VALID_UUID)]),
      recap: () => Promise.resolve({ recap: null, status: "not-found" as const }),
      statusline: () => Promise.resolve({ data: null, status: "not-found" as const }),
      readRegistry: () => { calls++; return Promise.resolve(ok([{ sessionId: VALID_UUID, status: "busy" }])); },
      recapIntervalMs: 999_999, initialSweepDelayMs: 999_999,
    });
    await p.pollOnce();
    p.start();
    await settleStart();
    calls = 0;
    await tick();
    p.stop();
    vi.useRealTimers();
    expect(calls).toBe(1);                       // ONE, not one per claudeConfigDirs entry
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBe("busy");
    expect(p.getSnapshot().sessions[0]?.registryStatus).toBe("ok");
  });

  it("skips a tick whose predecessor is still in flight", async () => {
    vi.useFakeTimers();
    let calls = 0;
    // An ARRAY of resolvers, not `let release: (() => void) | null`. TypeScript does not track
    // assignments made inside a callback, so a `let` initialised to `null` is still narrowed to `null`
    // at the call site below; array elements are not narrowed that way.
    const pending: (() => void)[] = [];
    const p = createPoller({
      envs: [A],
      list: () => Promise.resolve([rowWithSession(A.id, "p1", VALID_UUID)]),
      recap: () => Promise.resolve({ recap: null, status: "not-found" as const }),
      statusline: () => Promise.resolve({ data: null, status: "not-found" as const }),
      readRegistry: () => {
        calls++;
        return new Promise<RegistryRead>((res) => { pending.push(() => { res(ok([])); }); });
      },
      recapIntervalMs: 999_999, initialSweepDelayMs: 999_999,
    });
    await p.pollOnce();
    p.start();
    await settleStart();
    await tick();
    expect(calls).toBe(1);
    await tick();            // the first read has not resolved — this tick must do nothing
    expect(calls).toBe(1);
    for (const r of pending) r();
    await tick();            // now it may run again
    expect(calls).toBe(2);
    p.stop();
    vi.useRealTimers();
  });

  it("does not broadcast on a tick that changes nothing, and does on one that does", async () => {
    vi.useFakeTimers();
    let status = "idle";
    const p = createPoller({
      envs: [A],
      list: () => Promise.resolve([rowWithSession(A.id, "p1", VALID_UUID)]),
      recap: () => Promise.resolve({ recap: null, status: "not-found" as const }),
      statusline: () => Promise.resolve({ data: null, status: "not-found" as const }),
      readRegistry: () => Promise.resolve(ok([{ sessionId: VALID_UUID, status }])),
      recapIntervalMs: 999_999, initialSweepDelayMs: 999_999,
    });
    await p.pollOnce();
    p.start();
    await settleStart();
    await tick();                       // first read: lands the record
    const seen: Snapshot[] = [];
    p.onSnapshot((s) => seen.push(s));
    await tick();
    await tick();
    expect(seen).toEqual([]);           // almost every tick: no change, no frame
    status = "waiting";
    await tick();
    expect(seen).toHaveLength(1);
    p.stop();
    vi.useRealTimers();
  });

  // waitingFor ALONE. It is rendered — it is the "· input needed" half of the label — and it changes
  // without `status` changing whenever a session that is already waiting starts waiting on something
  // else. Dropping it from recordsEqual freezes that half of the label with no other test failing.
  it("broadcasts when only waitingFor changed, with status unchanged", async () => {
    vi.useFakeTimers();
    let waitingFor = "input needed";
    const p = createPoller({
      envs: [A],
      list: () => Promise.resolve([rowWithSession(A.id, "p1", VALID_UUID)]),
      recap: () => Promise.resolve({ recap: null, status: "not-found" as const }),
      statusline: () => Promise.resolve({ data: null, status: "not-found" as const }),
      readRegistry: () => Promise.resolve(ok([{ sessionId: VALID_UUID, status: "waiting", waitingFor }])),
      recapIntervalMs: 999_999, initialSweepDelayMs: 999_999,
    });
    await p.pollOnce();
    p.start();
    await settleStart();
    await tick();
    const seen: Snapshot[] = [];
    p.onSnapshot((s) => seen.push(s));
    waitingFor = "permission needed";
    await tick();
    expect(seen).toHaveLength(1);
    // And the frame carries the NEW reason — a broadcast of the stale value would be no better.
    expect(seen[0]?.sessions[0]?.waitingFor).toBe("permission needed");
    expect(seen[0]?.sessions[0]?.claudeStatus).toBe("waiting");
    p.stop();
    vi.useRealTimers();
  });

  // recordsEqual lists the compared fields BY HAND, so a field added to RegistryRecordSchema and not
  // added there silently stops broadcasting that field's changes. Pin the two lists against each other.
  // Source-level because recordsEqual is a closure inside createPoller and cannot be imported — the
  // same instrument test/ui-safety.test.ts uses for the render sites.
  it("recordsEqual compares every field RegistryRecordSchema declares", () => {
    const src = readFileSync(new URL("../server/poller.ts", import.meta.url).pathname, "utf8");
    const keys = Object.keys(RegistryRecordSchema.shape);
    expect(keys).toContain("sessionId");
    for (const key of keys) {
      // sessionId is required, so it is compared directly rather than through `?? null`.
      const expected = key === "sessionId"
        ? "a.sessionId === b.sessionId"
        : `(a.${key} ?? null) === (b.${key} ?? null)`;
      expect(src, key).toContain(expected);
    }
  });

  it("keeps the previous record and reports the failure when a read degrades", async () => {
    vi.useFakeTimers();
    let read: RegistryRead = ok([{ sessionId: VALID_UUID, status: "busy" }]);
    const p = createPoller({
      envs: [A],
      list: () => Promise.resolve([rowWithSession(A.id, "p1", VALID_UUID)]),
      recap: () => Promise.resolve({ recap: null, status: "not-found" as const }),
      statusline: () => Promise.resolve({ data: null, status: "not-found" as const }),
      readRegistry: () => Promise.resolve(read),
      recapIntervalMs: 999_999, initialSweepDelayMs: 999_999,
    });
    await p.pollOnce();
    p.start();
    await settleStart();
    await tick();
    read = { records: [], status: "read-error", truncated: false };
    await tick();
    p.stop();
    vi.useRealTimers();
    // Stale state is kept and LABELLED, not blanked — a momentary EACCES must not empty the board.
    expect(p.getSnapshot().sessions[0]?.claudeStatus).toBe("busy");
    expect(p.getSnapshot().sessions[0]?.registryStatus).toBe("read-error");
  });

  it("survives a reader that throws, and keeps ticking", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const p = createPoller({
      envs: [A],
      list: () => Promise.resolve([rowWithSession(A.id, "p1", VALID_UUID)]),
      recap: () => Promise.resolve({ recap: null, status: "not-found" as const }),
      statusline: () => Promise.resolve({ data: null, status: "not-found" as const }),
      readRegistry: () => { calls++; return Promise.reject(new Error("boom")); },
      recapIntervalMs: 999_999, initialSweepDelayMs: 999_999,
    });
    await p.pollOnce();
    p.start();
    await settleStart();
    calls = 0;
    await tick();
    await tick();
    p.stop();
    vi.useRealTimers();
    warn.mockRestore();
    // The re-entrancy flag must be cleared in a `finally`, or one throw stops the interval forever.
    expect(calls).toBe(2);
  });

  // The inner catch, which the outer `finally` alone does NOT cover: without it the first env's throw
  // aborts the loop and every later local environment is skipped for that whole tick.
  it("keeps reading the remaining local environments when one throws", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen: string[] = [];
    const p = createPoller({
      envs: [A, B],
      list: (e) => Promise.resolve([rowWithSession(e.id, "p1", VALID_UUID)]),
      recap: () => Promise.resolve({ recap: null, status: "not-found" as const }),
      statusline: () => Promise.resolve({ data: null, status: "not-found" as const }),
      readRegistry: (e) => {
        seen.push(e.id);
        return e.id === A.id
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(ok([{ sessionId: VALID_UUID, status: "busy" }]));
      },
      recapIntervalMs: 999_999, initialSweepDelayMs: 999_999,
    });
    await p.pollOnce();
    p.start();
    await settleStart();
    seen.length = 0;
    await tick();
    p.stop();
    vi.useRealTimers();
    expect(seen).toEqual(["a", "b"]);
    expect(p.getSnapshot().sessions.find((r) => r.env === "b")?.claudeStatus).toBe("busy");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("tick threw"))).toBe(true);
    warn.mockRestore();
  });

  it("stops ticking after stop()", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = createPoller({
      envs: [A],
      list: () => Promise.resolve([rowWithSession(A.id, "p1", VALID_UUID)]),
      recap: () => Promise.resolve({ recap: null, status: "not-found" as const }),
      statusline: () => Promise.resolve({ data: null, status: "not-found" as const }),
      readRegistry: () => { calls++; return Promise.resolve(ok([])); },
      recapIntervalMs: 999_999, initialSweepDelayMs: 999_999,
    });
    await p.pollOnce();
    p.start();
    await settleStart();
    await tick();
    const afterOneTick = calls;
    p.stop();
    await tick();
    await tick();
    vi.useRealTimers();
    expect(calls).toBe(afterOneTick);
  });

  // Nothing may tick before start(): createPoller is called in tests and on cold paths that never
  // start the poller, and a timer armed at construction would read the real config dirs there.
  it("does not tick before start()", async () => {
    vi.useFakeTimers();
    let calls = 0;
    createPoller({
      envs: [A],
      list: () => Promise.resolve([rowWithSession(A.id, "p1", VALID_UUID)]),
      readRegistry: () => { calls++; return Promise.resolve(ok([])); },
    });
    await tick();
    await tick();
    vi.useRealTimers();
    expect(calls).toBe(0);
  });
});
