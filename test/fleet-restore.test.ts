import type { SessionRow } from "@shared/schema";
import { describe, expect, it, vi } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import type { FleetMirrorFile } from "../server/fleet-mirror.ts";
import { createFleetRestore } from "../server/fleet-restore.ts";
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
