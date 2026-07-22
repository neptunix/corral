import type { AttentionMap, SessionRow, StatuslineData } from "@shared/schema";
import { describe, it, expect, vi } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import type { AttentionStore } from "../server/attention-store.ts";
import { createPoller, type ListFn, type RecapFn, type StatuslineFn } from "../server/poller.ts";

const A: HerdrEnv = { id: "a", label: "A", kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {} };
const B: HerdrEnv = { id: "b", label: "B", kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {} };
const row = (env: string, paneId: string): SessionRow => ({
  env, paneId, status: "working", agent: "claude", cwd: "/x", tab: "t", workspace: "w",
  sessionId: null, recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null,
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

const VALID_UUID = "a13ad559-8e59-4b98-b420-2746ef0b94d8";
const OTHER_UUID = "b24be66a-9f6a-5ca9-c531-3857fc1ca5e9";

function rowWithSession(env: string, paneId: string, sessionId: string): SessionRow {
  return { env, paneId, status: "working", agent: "claude", cwd: "/x", tab: "t", workspace: "w",
    sessionId, recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null };
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
  sessionId: null, recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null,
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
