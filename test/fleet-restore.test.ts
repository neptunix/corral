import type { SessionRow } from "@shared/schema";
import { describe, expect, it, vi } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import type { FleetMirrorFile } from "../server/fleet-mirror.ts";
import { createFleetRestore, RECENT_RESUME_WINDOW_MS } from "../server/fleet-restore.ts";
import type { SpawnOpts, SpawnResult } from "../server/spawn.ts";

const UUID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const UUID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const UUID_C = "cccccccc-0000-4000-8000-000000000003";

function env(id: string): HerdrEnv {
  return { id, label: id, kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {} };
}

function mirrorSession(sessionId: string, over?: { name?: string; cwd?: string; workspaceLabel?: string }) {
  return { sessionId, name: over?.name ?? "my-tab", cwd: over?.cwd ?? "/pane-cwd", workspaceLabel: over?.workspaceLabel ?? "acme:web" };
}

function mirrorOf(envId: string, sessions: ReturnType<typeof mirrorSession>[], pendingRestore = true): FleetMirrorFile {
  return { version: 1, envs: { [envId]: { updatedAt: 1700000000, pendingRestore, sessions } } };
}

function liveRow(envId: string, sessionId: string | null): SessionRow {
  return {
    env: envId, paneId: `p-${sessionId ?? "x"}`, status: "working", agent: "claude", cwd: "/pane-cwd",
    tab: "t", workspace: "w", sessionId, recap: null, recapAt: null, recapStatus: null,
    statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null,
    remoteControl: null, registryStatus: null,
  };
}

const okSpawn: SpawnResult = {
  paneId: "p9", tabId: "t9", workspaceId: "w9", workspaceLabel: "acme:web",
  tabLabel: "my-tab", cwdSnapshot: "/probed", idempotent: false,
};

function makeEngine(over?: {
  mirror?: FleetMirrorFile | null;
  readThrows?: string;
  live?: SessionRow[];
  listThrows?: string;
  spawn?: (o: SpawnOpts) => Promise<SpawnResult>;
  cwd?: (e: HerdrEnv, id: string) => Promise<string | null>;
  envs?: HerdrEnv[];
  now?: () => number;
}) {
  const spawn = vi.fn(over?.spawn ?? (async () => okSpawn));
  const clearPending = vi.fn();
  const engine = createFleetRestore({
    envs: over?.envs ?? [env("e1")],
    mirrorFilePath: "/unused-in-tests",
    spawn,
    clearPendingRestore: clearPending,
    listFn: async () => {
      if (over?.listThrows !== undefined) throw new Error(over.listThrows);
      return over?.live ?? [];
    },
    sessionCwdFn: over?.cwd ?? (async () => "/probed"),
    readMirrorFn: () => {
      if (over?.readThrows !== undefined) throw new Error(over.readThrows);
      return over?.mirror === undefined ? mirrorOf("e1", [mirrorSession(UUID_A)]) : over.mirror;
    },
    ...(over?.now !== undefined ? { nowFn: over.now } : {}),
  });
  return { engine, spawn, clearPending };
}

describe("createFleetRestore statuses", () => {
  it("unknown env → unknown_env, nothing listed or spawned", async () => {
    const { engine, spawn } = makeEngine();
    const run = await engine.run({ env: "nope" });
    expect(run).toEqual({ status: "unknown_env", env: "nope" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("missing mirror file → no_mirror", async () => {
    const { engine } = makeEngine({ mirror: null });
    expect(await engine.run({})).toEqual({ status: "no_mirror" });
  });

  it("unreadable mirror → mirror_unreadable with the reader's message", async () => {
    const { engine } = makeEngine({ readThrows: "fleet mirror /x failed validation" });
    const run = await engine.run({});
    expect(run.status).toBe("mirror_unreadable");
    if (run.status === "mirror_unreadable") expect(run.message).toContain("failed validation");
  });

  it("a second run while one is in flight → in_flight", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const { engine } = makeEngine({ spawn: async () => { await gate; return okSpawn; } });
    const first = engine.run({});
    // Validation runs before the in-flight guard: a typo diagnoses even mid-restore.
    expect(await engine.run({ env: "nope" })).toEqual({ status: "unknown_env", env: "nope" });
    const second = await engine.run({});
    expect(second).toEqual({ status: "in_flight" });
    release?.();
    await first;
    expect((await engine.run({ dryRun: true })).status).toBe("ok"); // flag released
  });

  it("configured env absent from the mirror (explicit filter) → env-level not_in_mirror", async () => {
    const { engine } = makeEngine({ envs: [env("e1"), env("e2")] });
    const run = await engine.run({ env: "e2" });
    expect(run.status).toBe("ok");
    if (run.status === "ok") {
      expect(run.report.envs.e2).toEqual({ error: "not_in_mirror", updatedAt: null, unmirrored: 0, sessions: [] });
    }
  });

  it("without a filter, only configured envs present in the mirror are processed", async () => {
    const mirror: FleetMirrorFile = {
      version: 1,
      envs: {
        e1: { updatedAt: 1, pendingRestore: false, sessions: [mirrorSession(UUID_A)] },
        ghost: { updatedAt: 1, pendingRestore: false, sessions: [mirrorSession(UUID_B)] }, // removed env: ignored
      },
    };
    const { engine } = makeEngine({ envs: [env("e1"), env("e2")], mirror });
    const run = await engine.run({ dryRun: true });
    expect(run.status).toBe("ok");
    if (run.status === "ok") expect(Object.keys(run.report.envs)).toEqual(["e1"]);
  });

  it("listing failure → env-level error; other envs proceed", async () => {
    const mirror: FleetMirrorFile = {
      version: 1,
      envs: {
        e1: { updatedAt: 1, pendingRestore: false, sessions: [mirrorSession(UUID_A)] },
        e2: { updatedAt: 2, pendingRestore: false, sessions: [mirrorSession(UUID_B)] },
      },
    };
    const listFn = vi.fn(async (e: HerdrEnv): Promise<SessionRow[]> => {
      if (e.id === "e1") throw new Error("ssh timeout");
      return [];
    });
    const spawn = vi.fn(async () => okSpawn);
    const engine = createFleetRestore({
      envs: [env("e1"), env("e2")], mirrorFilePath: "/unused", spawn,
      clearPendingRestore: () => undefined, listFn,
      sessionCwdFn: async () => null, readMirrorFn: () => mirror,
    });
    const run = await engine.run({});
    expect(run.status).toBe("ok");
    if (run.status === "ok") {
      expect(run.report.envs.e1?.error).toContain("ssh timeout");
      expect(run.report.envs.e1?.sessions).toEqual([]);
      expect(run.report.envs.e2?.sessions[0]?.outcome).toBe("resumed");
    }
  });
});

describe("createFleetRestore dry run", () => {
  it("inventories without spawning: would_resume / skipped_alive, and counts unmirrored", async () => {
    const mirror = mirrorOf("e1", [mirrorSession(UUID_A), mirrorSession(UUID_B)]);
    const { engine, spawn, clearPending } = makeEngine({
      mirror,
      live: [liveRow("e1", UUID_A), liveRow("e1", UUID_C), liveRow("e1", null)], // C is live-but-unmirrored
    });
    const run = await engine.run({ dryRun: true });
    expect(run.status).toBe("ok");
    if (run.status === "ok") {
      const e1 = run.report.envs.e1;
      expect(run.report.dryRun).toBe(true);
      expect(e1?.updatedAt).toBe(1700000000);
      expect(e1?.unmirrored).toBe(1);
      expect(e1?.sessions.map((s) => s.outcome).sort()).toEqual(["skipped_alive", "would_resume"]);
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(clearPending).not.toHaveBeenCalled(); // dry run never clears the flag
  });
});

describe("createFleetRestore live resume", () => {
  it("passes the probed cwd as BOTH cwd and repoPath, resolves by label, resumes with the env's spawn command", async () => {
    const { engine, spawn } = makeEngine({
      mirror: mirrorOf("e1", [mirrorSession(UUID_A, { cwd: "/pane-cwd", workspaceLabel: "acme:web" })]),
      cwd: async () => "/probed",
    });
    const run = await engine.run({});
    expect(run.status).toBe("ok");
    const call = spawn.mock.calls[0]?.[0];
    expect(call?.cwd).toBe("/probed");
    expect(call?.repoPath).toBe("/probed");
    expect(call?.repo).toBe("acme:web");
    expect(call?.targetWorkspaceId).toBeUndefined();
    expect(call?.resumeSessionId).toBe(UUID_A);
    expect(call?.spawnCommand).toBe("claude");
    expect(call?.sessionName).toBe("my-tab");
    expect(call?.assignedPaneIds.size).toBe(0);
  });

  it("probe failure falls back to the mirrored pane cwd", async () => {
    const { engine, spawn } = makeEngine({
      mirror: mirrorOf("e1", [mirrorSession(UUID_A, { cwd: "/pane-cwd" })]),
      cwd: async () => { throw new Error("no transcript"); },
    });
    await engine.run({});
    expect(spawn.mock.calls[0]?.[0]?.cwd).toBe("/pane-cwd");
    expect(spawn.mock.calls[0]?.[0]?.repoPath).toBe("/pane-cwd");
  });

  it('placeholder workspace labels ("" and "?") do NOT group: repo is null, label falls back to the session name', async () => {
    const { engine, spawn } = makeEngine({
      mirror: mirrorOf("e1", [
        mirrorSession(UUID_A, { workspaceLabel: "?" }),
        mirrorSession(UUID_B, { workspaceLabel: "", name: "" }),
      ]),
    });
    await engine.run({});
    expect(spawn.mock.calls[0]?.[0]?.repo).toBeNull();
    expect(spawn.mock.calls[1]?.[0]?.repo).toBeNull();
    // unusable name → restored-<uuid8> for the tab, and its slug for the workspace label
    expect(spawn.mock.calls[1]?.[0]?.sessionName).toBe(`restored-${UUID_B.slice(0, 8)}`);
    expect(spawn.mock.calls[1]?.[0]?.taskSlug).toBe(`restored-${UUID_B.slice(0, 8)}`);
  });

  it("same-label records are resumed adjacently (create then join-by-label), interleaved input notwithstanding", async () => {
    const { engine, spawn } = makeEngine({
      mirror: mirrorOf("e1", [
        mirrorSession(UUID_A, { workspaceLabel: "acme:web" }),
        mirrorSession(UUID_B, { workspaceLabel: "other" }),
        mirrorSession(UUID_C, { workspaceLabel: "acme:web" }),
      ]),
    });
    await engine.run({});
    const orderedIds = spawn.mock.calls.map((c) => c[0].resumeSessionId);
    expect(orderedIds).toEqual([UUID_A, UUID_C, UUID_B]);
  });

  it("one spawn failure → failed entry, the sequence continues, pendingRestore stays set", async () => {
    const spawnImpl = vi.fn(async (o: SpawnOpts): Promise<SpawnResult> => {
      if (o.resumeSessionId === UUID_A) throw new Error("pane run failed");
      return okSpawn;
    });
    const { engine, clearPending } = makeEngine({
      mirror: mirrorOf("e1", [mirrorSession(UUID_A), mirrorSession(UUID_B)]),
      spawn: spawnImpl,
    });
    const run = await engine.run({});
    expect(run.status).toBe("ok");
    if (run.status === "ok") {
      const outcomes = new Map(run.report.envs.e1?.sessions.map((s) => [s.sessionId, s.outcome]));
      expect(outcomes.get(UUID_A)).toBe("failed");
      expect(outcomes.get(UUID_B)).toBe("resumed");
    }
    expect(clearPending).not.toHaveBeenCalled();
  });

  it("a zero-failed run clears pendingRestore for the env", async () => {
    const { engine, clearPending } = makeEngine({
      mirror: mirrorOf("e1", [mirrorSession(UUID_A)]),
    });
    await engine.run({});
    expect(clearPending).toHaveBeenCalledWith("e1");
  });

  it("an immediate re-run resumes nothing the previous run spawned (skipped_recent); after the window a still-dead session is retried", async () => {
    let clock = 1_000_000_000_000;
    const { engine, spawn } = makeEngine({
      mirror: mirrorOf("e1", [mirrorSession(UUID_A)]),
      now: () => clock,
    });
    await engine.run({});
    expect(spawn).toHaveBeenCalledTimes(1);
    clock += 10_000; // 10s later — inside the window
    const rerun = await engine.run({});
    expect(spawn).toHaveBeenCalledTimes(1);
    if (rerun.status === "ok") expect(rerun.report.envs.e1?.sessions[0]?.outcome).toBe("skipped_recent");
    clock += RECENT_RESUME_WINDOW_MS; // well past the window, session still dead
    await engine.run({});
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("a record with an invalid uuid is failed, never spawned", async () => {
    const mirror: FleetMirrorFile = {
      version: 1,
      envs: { e1: { updatedAt: 1, pendingRestore: false, sessions: [mirrorSession("evil; rm -rf /")] } },
    };
    const { engine, spawn } = makeEngine({ mirror });
    const run = await engine.run({});
    expect(spawn).not.toHaveBeenCalled();
    if (run.status === "ok") expect(run.report.envs.e1?.sessions[0]?.outcome).toBe("failed");
  });

  it("idempotent rejoin (a live tab with this name already exists) → failed, not resumed; pendingRestore stays set", async () => {
    const { engine, clearPending } = makeEngine({
      mirror: mirrorOf("e1", [mirrorSession(UUID_A)]),
      spawn: async () => ({ ...okSpawn, idempotent: true }),
    });
    const run = await engine.run({});
    expect(run.status).toBe("ok");
    if (run.status === "ok") {
      const s = run.report.envs.e1?.sessions[0];
      expect(s?.outcome).toBe("failed");
      expect(s?.error).toContain("collision");
    }
    expect(clearPending).not.toHaveBeenCalled();
  });

  it("two records whose names slugify to the same tab name → first resumes, second collides and fails", async () => {
    let calls = 0;
    const spawnImpl = vi.fn(async (): Promise<SpawnResult> => {
      calls += 1;
      return calls === 1 ? okSpawn : { ...okSpawn, idempotent: true };
    });
    const { engine } = makeEngine({
      mirror: mirrorOf("e1", [
        mirrorSession(UUID_A, { name: "Fix (a)" }),
        mirrorSession(UUID_B, { name: "Fix [a]" }),
      ]),
      spawn: spawnImpl,
    });
    const run = await engine.run({});
    expect(run.status).toBe("ok");
    if (run.status === "ok") {
      expect(run.report.envs.e1?.sessions.map((s) => s.outcome)).toEqual(["resumed", "failed"]);
    }
  });

  it("resumes run sequentially across a multi-session mirror, never concurrently", async () => {
    let inFlightCount = 0;
    let max = 0;
    const spawnImpl = vi.fn(async (): Promise<SpawnResult> => {
      inFlightCount += 1;
      max = Math.max(max, inFlightCount);
      await new Promise((r) => setTimeout(r, 0));
      inFlightCount -= 1;
      return okSpawn;
    });
    const { engine } = makeEngine({
      mirror: mirrorOf("e1", [mirrorSession(UUID_A), mirrorSession(UUID_B), mirrorSession(UUID_C)]),
      spawn: spawnImpl,
    });
    await engine.run({});
    expect(max).toBe(1);
  });
});
