import type { EnvState, SessionRow, Snapshot } from "@shared/schema";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFleetMirror, ensureMirrorGitignore, FLEET_MIRROR_FILENAME, mirrorPath, readMirrorFile } from "../server/fleet-mirror.ts";
import type { Poller } from "../server/poller.ts";

const UUID_A = "aaaaaaaa-0000-4000-8000-000000000001";

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "fleet-mirror-test-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function validFile(): unknown {
  return {
    version: 1,
    envs: {
      e1: {
        updatedAt: 1700000000, pendingRestore: false,
        sessions: [{ sessionId: UUID_A, name: "my-tab", cwd: "/repo", workspaceLabel: "acme:web" }],
      },
    },
  };
}

describe("readMirrorFile", () => {
  it("returns null when the file does not exist", () => {
    expect(readMirrorFile(mirrorPath(tmpDir))).toBeNull();
  });

  it("parses a valid mirror file", () => {
    const p = mirrorPath(tmpDir);
    writeFileSync(p, JSON.stringify(validFile()));
    expect(readMirrorFile(p)?.envs.e1?.sessions[0]?.sessionId).toBe(UUID_A);
  });

  it("throws, naming the file, on invalid JSON", () => {
    const p = mirrorPath(tmpDir);
    writeFileSync(p, "{nope");
    expect(() => readMirrorFile(p)).toThrow(p);
  });

  it("rejects a record whose sessionId is not a uuid (fail secure — it must never spawn)", () => {
    const p = mirrorPath(tmpDir);
    const bad = validFile();
    (bad as { envs: { e1: { sessions: { sessionId: string }[] } } }).envs.e1.sessions[0]!.sessionId = "abc; rm -rf /";
    writeFileSync(p, JSON.stringify(bad));
    expect(() => readMirrorFile(p)).toThrow(p);
  });

  it("mirrorPath joins dataDir with the fixed filename", () => {
    expect(mirrorPath("/data")).toBe(path.join("/data", FLEET_MIRROR_FILENAME));
  });
});

const UUID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const UUID_C = "cccccccc-0000-4000-8000-000000000003";

// Same stub as test/reconcile.test.ts — snapshot + subscribers driven by hand.
function fakePoller() {
  let snap: Snapshot = { envs: {}, sessions: [] };
  const subs = new Set<(s: Snapshot) => void>();
  const poller: Poller = {
    getSnapshot: () => snap,
    getAttention: () => ({}),
    onSnapshot: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    pollOnce: async () => {},
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    refreshEnv: async () => {},
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    runClaudeSweepOnce: async () => {},
    applyRegistry: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    start: () => {},
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    stop: () => {},
  };
  return {
    poller,
    set: (envs: Record<string, EnvState>, sessions: SessionRow[]) => { snap = { envs, sessions }; },
    emit: () => { for (const cb of subs) cb(snap); },
  };
}

const UP: EnvState = { reachable: true, kind: "local", label: "E1" };
const DOWN: EnvState = { reachable: false, error: "boom", kind: "local", label: "E1" };

function row(env: string, sessionId: string | null, over?: Partial<SessionRow>): SessionRow {
  return {
    env, paneId: `p-${sessionId ?? "x"}`, status: "working", agent: "claude", cwd: "/repo",
    tab: "my-tab", workspace: "acme:web", sessionId, recap: null, recapAt: null, recapStatus: null, recapSource: null,
    statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null,
    remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null, ...over,
  };
}

describe("createFleetMirror write policy", () => {
  it("steady state replaces: a closed session drops, a new one appears", () => {
    const fp = fakePoller();
    const m = createFleetMirror({ dataDir: tmpDir });
    m.start(fp.poller);
    fp.set({ e1: UP }, [row("e1", UUID_A), row("e1", UUID_B)]);
    fp.emit(); // first observation: merge (all live) → both recorded, no pending
    fp.set({ e1: UP }, [row("e1", UUID_B), row("e1", UUID_C)]);
    fp.emit(); // steady: replace
    const ids = m.getState().envs.e1?.sessions.map((s) => s.sessionId);
    expect(ids).toEqual([UUID_B, UUID_C]);
    expect(m.getState().envs.e1?.pendingRestore).toBe(false);
  });

  it("BLOCKER CASE: unreachable freezes; reachable-EMPTY after the gap merges (wipes nothing) and sets pendingRestore", () => {
    const fp = fakePoller();
    const m = createFleetMirror({ dataDir: tmpDir });
    m.start(fp.poller);
    fp.set({ e1: UP }, [row("e1", UUID_A), row("e1", UUID_B)]);
    fp.emit();
    fp.set({ e1: DOWN }, [row("e1", UUID_A), row("e1", UUID_B)]); // stale rows linger on a failed poll
    fp.emit();
    expect(m.getState().envs.e1?.sessions).toHaveLength(2); // outage: holds
    fp.set({ e1: UP }, []); // herdr restarted empty — reachable with zero sessions
    fp.emit();
    expect(m.getState().envs.e1?.sessions).toHaveLength(2); // NOT wiped
    expect(m.getState().envs.e1?.pendingRestore).toBe(true);
  });

  it("first observation of the process with missing records → merge-only + pendingRestore (corral restarted during the outage)", () => {
    // Seed a mirror file from a "previous corral run", then build a NEW mirror over it.
    const fp1 = fakePoller();
    const m1 = createFleetMirror({ dataDir: tmpDir });
    m1.start(fp1.poller);
    fp1.set({ e1: UP }, [row("e1", UUID_A), row("e1", UUID_B)]);
    fp1.emit();
    const fp2 = fakePoller();
    const m2 = createFleetMirror({ dataDir: tmpDir }); // fresh process, no in-memory transition
    m2.start(fp2.poller);
    fp2.set({ e1: UP }, [row("e1", UUID_A)]); // B missing
    fp2.emit();
    expect(m2.getState().envs.e1?.sessions.map((s) => s.sessionId)).toEqual([UUID_A, UUID_B]);
    expect(m2.getState().envs.e1?.pendingRestore).toBe(true);
  });

  it("first observation with ALL records live → no pending (fleet intact)", () => {
    const fp1 = fakePoller();
    const m1 = createFleetMirror({ dataDir: tmpDir });
    m1.start(fp1.poller);
    fp1.set({ e1: UP }, [row("e1", UUID_A)]);
    fp1.emit();
    const fp2 = fakePoller();
    const m2 = createFleetMirror({ dataDir: tmpDir });
    m2.start(fp2.poller);
    fp2.set({ e1: UP }, [row("e1", UUID_A)]);
    fp2.emit();
    expect(m2.getState().envs.e1?.pendingRestore).toBe(false);
  });

  it("while pending, polls never drop records; pending clears once every record is live again", () => {
    const fp = fakePoller();
    const m = createFleetMirror({ dataDir: tmpDir });
    m.start(fp.poller);
    fp.set({ e1: UP }, [row("e1", UUID_A), row("e1", UUID_B)]);
    fp.emit();
    fp.set({ e1: DOWN }, []);
    fp.emit();
    fp.set({ e1: UP }, [row("e1", UUID_A)]); // mid-restore: only A back
    fp.emit();
    expect(m.getState().envs.e1?.sessions).toHaveLength(2); // B kept for the re-run
    expect(m.getState().envs.e1?.pendingRestore).toBe(true);
    fp.emit(); // more pending polls change nothing
    expect(m.getState().envs.e1?.sessions).toHaveLength(2);
    fp.set({ e1: UP }, [row("e1", UUID_A), row("e1", UUID_B)]); // fleet fully back
    fp.emit();
    expect(m.getState().envs.e1?.pendingRestore).toBe(false);
    fp.set({ e1: UP }, [row("e1", UUID_A)]); // next steady poll may replace again
    fp.emit();
    expect(m.getState().envs.e1?.sessions).toHaveLength(1);
  });

  it("rows without a valid uuid never enter the mirror", () => {
    const fp = fakePoller();
    const m = createFleetMirror({ dataDir: tmpDir });
    m.start(fp.poller);
    fp.set({ e1: UP }, [row("e1", null), row("e1", "not-a-uuid"), row("e1", UUID_A)]);
    fp.emit();
    expect(m.getState().envs.e1?.sessions.map((s) => s.sessionId)).toEqual([UUID_A]);
  });

  it("compare-before-write: identical fleet → no second write; updatedAt moves only on structural change", () => {
    const fp = fakePoller();
    let now = 1_000_000_000_000;
    const m = createFleetMirror({ dataDir: tmpDir, nowFn: () => now });
    m.start(fp.poller);
    fp.set({ e1: UP }, [row("e1", UUID_A)]);
    fp.emit();
    const first = readFileSync(mirrorPath(tmpDir), "utf8");
    now += 60_000;
    fp.emit(); // unchanged fleet
    expect(readFileSync(mirrorPath(tmpDir), "utf8")).toBe(first); // no rewrite, updatedAt untouched
    now += 60_000;
    fp.set({ e1: UP }, [row("e1", UUID_A), row("e1", UUID_B)]);
    fp.emit();
    const state = m.getState();
    expect(state.envs.e1?.updatedAt).toBe(Math.floor(now / 1000));
  });

  it("an env with no claude sessions and no prior entry is not written at all (404 no_mirror stays meaningful)", () => {
    const fp = fakePoller();
    const m = createFleetMirror({ dataDir: tmpDir });
    m.start(fp.poller);
    fp.set({ e1: UP }, []);
    fp.emit();
    expect(existsSync(mirrorPath(tmpDir))).toBe(false);
    expect(m.getState().envs.e1).toBeUndefined();
  });

  it("an env absent from the snapshot keeps its entry (removed-from-config envs are not pruned)", () => {
    const fp = fakePoller();
    const m = createFleetMirror({ dataDir: tmpDir });
    m.start(fp.poller);
    fp.set({ e1: UP, e2: UP }, [row("e1", UUID_A), row("e2", UUID_B)]);
    fp.emit();
    fp.set({ e1: UP }, [row("e1", UUID_A)]); // e2 gone from config/snapshot
    fp.emit();
    expect(m.getState().envs.e2?.sessions).toHaveLength(1);
  });

  it("a write failure is contained: later subscribers still run, next emissions still work", () => {
    const fp = fakePoller();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const m = createFleetMirror({ dataDir: path.join(tmpDir, "gone") }); // parent dir missing → writeAtomic throws
    m.start(fp.poller);
    const after = vi.fn();
    fp.poller.onSnapshot(after);
    fp.set({ e1: UP }, [row("e1", UUID_A)]);
    expect(() => { fp.emit(); }).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    fp.emit(); // the write is RETRIED (same error) → still one warn: deduped per distinct message
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("[fleet-mirror]"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("a failed write is retried on a later tick even when nothing structural changed since", () => {
    const fp = fakePoller();
    const dir = path.join(tmpDir, "late");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const m = createFleetMirror({ dataDir: dir }); // parent dir missing → the first write fails
    m.start(fp.poller);
    fp.set({ e1: UP }, [row("e1", UUID_A)]);
    fp.emit(); // write fails (ENOENT)
    expect(existsSync(mirrorPath(dir))).toBe(false);
    mkdirSync(dir, { recursive: true });
    fp.emit(); // identical fleet, zero structural change — persist() still runs and now succeeds
    expect(existsSync(mirrorPath(dir))).toBe(true);
    warn.mockRestore();
  });

  it("corrupt file at startup is renamed aside and mirroring starts fresh", () => {
    writeFileSync(mirrorPath(tmpDir), "{corrupt");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const m = createFleetMirror({ dataDir: tmpDir });
    expect(m.getState().envs).toEqual({});
    const aside = readdirSync(tmpDir).find((f) => f.startsWith(`${FLEET_MIRROR_FILENAME}.corrupt-`));
    expect(aside).toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

});

describe("ensureMirrorGitignore", () => {
  it("adds the line exactly once, preserving existing content, and untracks a previously tracked mirror", async () => {
    const gi = path.join(tmpDir, ".gitignore");
    writeFileSync(gi, "boards-backup/\n");
    const calls: (readonly string[])[] = [];
    const gitFn = async (_cwd: string, args: readonly string[]): Promise<void> => { calls.push(args); };
    await ensureMirrorGitignore(tmpDir, gitFn);
    await ensureMirrorGitignore(tmpDir, gitFn); // idempotent
    const content = readFileSync(gi, "utf8");
    expect(content.split("\n").filter((l) => l === "fleet-mirror.json*")).toHaveLength(1);
    expect(content.startsWith("boards-backup/\n")).toBe(true);
    expect(calls[0]).toEqual(["rm", "--cached", "--ignore-unmatch", "-q", FLEET_MIRROR_FILENAME]);
  });

  it("creates .gitignore when absent and survives a failing git", async () => {
    const gitFn = async (): Promise<void> => { throw new Error("not a repo"); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(ensureMirrorGitignore(tmpDir, gitFn)).resolves.toBeUndefined();
    expect(readFileSync(path.join(tmpDir, ".gitignore"), "utf8")).toContain("fleet-mirror.json*");
    warn.mockRestore();
  });
});
