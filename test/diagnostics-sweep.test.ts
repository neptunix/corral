import type { Snapshot } from "@shared/schema";
import { describe, it, expect } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { ctxHookChecks } from "../server/diagnostics/ctx-hook.ts";
import { createNodeDeps } from "../server/diagnostics/deps.ts";
import { driftCheck, themeCheck } from "../server/diagnostics/drift.ts";
import { metricsChecks } from "../server/diagnostics/metrics.ts";
import type { DiagnosticsStore } from "../server/diagnostics-store.ts";
import { createDiagnosticsStore } from "../server/diagnostics-store.ts";
import { createDiagnosticsSweep, REMOTE_DIR_SUBJECTS, type SweepOpts } from "../server/diagnostics-sweep.ts";

const local = (id: string): HerdrEnv => ({
  id, label: id, kind: "local", claudeConfigDirs: ["/h/.claude"], spawnCommand: "claude", repos: {},
});
const remote = (id: string): HerdrEnv => ({
  id, label: id, kind: "remote", sshHost: "h", socket: "~/s.sock", herdrBin: "herdr",
  claudeConfigDirs: ["/far/.claude"], spawnCommand: "claude", repos: {},
});
const snapshot = (envs: Snapshot["envs"]): Snapshot => ({ envs, sessions: [] });

/**
 * Counts sweep BODIES, entry and exit, and reports whether two were ever inside at once.
 *
 * The instrument is the sweep's own injected collaborators, at the two points a body provably passes
 * exactly once: `poller.getSnapshot()` at the top, and `store.setLastError()` as its last act on both
 * the success and the failure path. Counting `run` calls instead cannot do this — `versionChecks`
 * fires its three probes through one `Promise.all`, so one lone body already looks like three — and
 * counting probe ROUNDS is weaker: a variant that stamped the version TTL before awaiting the probes
 * would run two fully concurrent bodies and still leave the round count at 1.
 */
function bodyCounter(): {
  readonly store: DiagnosticsStore;
  readonly poller: { getSnapshot: () => Snapshot };
  readonly counts: { entered: number; overlap: boolean };
} {
  const inner = createDiagnosticsStore({ selfVersion: null });
  const counts = { entered: 0, overlap: false };
  let active = 0;
  return {
    counts,
    poller: {
      getSnapshot: () => {
        counts.entered += 1;
        active += 1;
        if (active > 1) counts.overlap = true;
        return snapshot({ work: { reachable: true } });
      },
    },
    store: {
      put: (cls, checks) => { inner.put(cls, checks); },
      patchSelf: (patch) => { inner.patchSelf(patch); },
      setLastError: (message) => { active -= 1; inner.setLastError(message); },
      snapshot: () => inner.snapshot(),
    },
  };
}

const opts = (over: Partial<SweepOpts>): SweepOpts => ({
  store: createDiagnosticsStore({ selfVersion: "0.0.0" }),
  poller: { getSnapshot: () => snapshot({ work: { reachable: true } }) },
  envs: [local("work")],
  deps: createNodeDeps({ repoRoot: "/repo" }),
  corralHome: "/h/.corral",
  configLine: { level: "ok", text: "config: 1 environment(s) loaded from /cfg.json" },
  run: () => Promise.resolve(null),
  intervalMs: 60_000, versionTtlMs: 600_000,
  ...over,
});

describe("createDiagnosticsSweep", () => {
  it("fills both classes on the first tick", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const sweep = createDiagnosticsSweep(opts({ store }));
    await sweep.tick();
    expect(store.snapshot().answered.sort()).toEqual(["cheap", "versions"]);
  });

  it("keeps version rows across a cheap-only re-tick", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const sweep = createDiagnosticsSweep(opts({ store, run: (b, a) => Promise.resolve([b, ...a].join(" ") === "herdr --version" ? "herdr 0.7.5" : null) }));
    await sweep.tick();
    const before = store.snapshot().checks.filter((c) => c.class === "versions").length;
    expect(before).toBeGreaterThan(0);
    await sweep.tick();
    expect(store.snapshot().checks.filter((c) => c.class === "versions")).toHaveLength(before);
  });

  it("honours the version TTL on tick and ignores it on refresh", async () => {
    let calls = 0;
    const sweep = createDiagnosticsSweep(opts({ run: () => { calls += 1; return Promise.resolve(null); } }));
    await sweep.tick();
    const afterFirst = calls;
    await sweep.tick();
    expect(calls).toBe(afterFirst); // inside the TTL: not re-run
    await sweep.refresh();
    expect(calls).toBeGreaterThan(afterFirst); // Recheck must actually re-check
  });

  it("emits pending rows for a remote environment instead of stat'ing local paths", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const sweep = createDiagnosticsSweep(opts({
      store, envs: [remote("box")],
      poller: { getSnapshot: () => snapshot({ box: { reachable: true } }) },
    }));
    await sweep.tick();
    const rows = store.snapshot().checks.filter((c) => c.scope.kind === "configDir");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((c) => c.state === "pending")).toBe(true);
  });

  it("produces no duplicate keys", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const sweep = createDiagnosticsSweep(opts({
      store, envs: [local("work"), remote("box")],
      poller: { getSnapshot: () => snapshot({ work: { reachable: true }, box: { reachable: false, error: "down" } }) },
    }));
    await sweep.tick();
    const keys = store.snapshot().checks.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not run the version probes for a remote environment", async () => {
    const ran: string[] = [];
    const sweep = createDiagnosticsSweep(opts({
      envs: [remote("box")],
      poller: { getSnapshot: () => snapshot({ box: { reachable: true } }) },
      run: (bin, args) => { ran.push([bin, ...args].join(" ")); return Promise.resolve(null); },
    }));
    await sweep.tick();
    expect(ran).toEqual([]);
  });

  it("records the failure on the snapshot, and clears it on the next good tick", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    let explode = false;
    const deps = { ...createNodeDeps({ repoRoot: "/repo" }),
      isFile: () => { if (explode) throw new Error("boom"); return true; } };
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const sweep = createDiagnosticsSweep(opts({ store, deps, warn: () => {} }));
    await sweep.tick();
    expect(store.snapshot().lastError).toBe(null);
    explode = true;
    await sweep.tick();
    // A failing sweep keeps its previous rows on purpose, so without this field the snapshot would
    // go on looking exactly like a healthy one.
    expect(store.snapshot().lastError).toContain("boom");
    explode = false;
    await sweep.refresh();
    expect(store.snapshot().lastError).toBe(null);
  });

  it("refresh re-checks even when a tick is already in flight — the whole point of Recheck", async () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const probes: string[] = [];
    const sweep = createDiagnosticsSweep(opts({
      run: async (bin, args) => {
        const cmd = [bin, ...args].join(" ");
        if (cmd === "herdr --version") probes.push(cmd);
        await gate;
        return null;
      },
    }));
    const first = sweep.tick();
    const second = sweep.refresh();   // lands mid-tick, exactly the case that breaks
    release();
    await Promise.all([first, second]);
    // Two rounds. A guard that no-ops, and one that merely joins the run in flight, both leave ONE —
    // and both would tell an operator who just installed jq that it is still missing.
    expect(probes).toHaveLength(2);
  });

  it("survives a throwing dependency, warns once, and keeps the previous results", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const warnings: string[] = [];
    let explode = false;
    const deps = { ...createNodeDeps({ repoRoot: "/repo" }),
      isFile: () => { if (explode) throw new Error("boom"); return true; } };
    const sweep = createDiagnosticsSweep(opts({ store, deps, warn: (m) => warnings.push(m) }));
    await sweep.tick();
    const before = store.snapshot().checks.length;
    explode = true;
    await expect(sweep.tick()).resolves.toBeUndefined();
    await sweep.tick();
    expect(store.snapshot().checks).toHaveLength(before);
    expect(warnings).toHaveLength(1); // once per distinct error, not per tick
  });

  it("does not run two ticks concurrently", async () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { store, poller, counts } = bodyCounter();
    const sweep = createDiagnosticsSweep(opts({
      store, poller,
      run: async () => { await gate; return null; },
    }));
    const first = sweep.tick();
    const second = sweep.tick(); // must collapse onto the run already in flight, not start a second
    release();
    await Promise.all([first, second]);
    expect(counts.entered).toBe(1);
    expect(counts.overlap).toBe(false);
  });

  it("serializes two Rechecks that land on a run already in flight", async () => {
    // The re-entrancy case: both Rechecks observe the SAME in-flight tick. An implementation that
    // awaits the tail and only then starts lets both resume past that await and both start, so two
    // sweep bodies run at once — duplicate herdr/claude spawns, two `publish` calls racing on the
    // store, and either one's `lastError` clobbered by the other.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { store, poller, counts } = bodyCounter();
    const sweep = createDiagnosticsSweep(opts({
      store, poller,
      run: async () => { await gate; return null; },
    }));
    const ticked = sweep.tick();
    const first = sweep.refresh();
    const second = sweep.refresh();
    release();
    await Promise.all([ticked, first, second]);
    // All three ran: a Recheck that collapsed onto the tick would answer with a verdict predating the
    // request, which is the bug on the other side of this one.
    expect(counts.entered).toBe(3);
    expect(counts.overlap).toBe(false);
  });

  it("drops only the by-design duplicate — any other key collision stays visible", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    // A hand-written environments.json can name the same config dir twice, and then the per-dir
    // producers legitimately emit the same key twice. That collision must NOT be absorbed here: only
    // `claude-config-dirs` is, because two prior producers each own a copy of that row by design.
    const sweep = createDiagnosticsSweep(opts({
      store,
      envs: [{ ...local("work"), claudeConfigDirs: ["/h/.claude", "/h/.claude"] }],
    }));
    await sweep.tick();
    const rows = store.snapshot().checks;
    expect(rows.filter((c) => c.id === "claude-config-dirs")).toHaveLength(1);
    const themeKeys = rows.filter((c) => c.id === "theme-installed").map((c) => c.key);
    expect(themeKeys).toHaveLength(2); // a blanket first-wins dedupe would silently leave 1
    expect(new Set(themeKeys).size).toBe(1);
  });
});

describe("REMOTE_DIR_SUBJECTS mirrors the local per-config-dir producers", () => {
  it("covers exactly the ids the local producers emit for one dir", () => {
    // The mirror is hand-maintained and invisible to the type system: a per-dir check added to
    // metrics.ts / ctx-hook.ts / drift.ts would simply stop appearing for every remote environment,
    // with nothing failing. This is the only thing that notices.
    const deps = {
      ...createNodeDeps({ repoRoot: "/repo" }),
      isFile: () => false, isExec: () => false, isDir: () => false,
      readText: () => null, hashFile: () => null, now: () => 1,
    };
    const produced = [
      ...metricsChecks(deps, "work", "/h/.claude"),
      ...ctxHookChecks(deps, "work", "/h/.claude"),
      driftCheck(deps, "work", "/h/.claude"),
      themeCheck(deps, "work", "/h/.claude"),
    ].map((c) => c.id);
    const mirrored = REMOTE_DIR_SUBJECTS.map((s) => s.id);
    const notMirrored = produced.filter((id) => !mirrored.includes(id));
    const staleMirror = mirrored.filter((id) => !produced.includes(id));
    // Named, not just counted: the failure output has to say WHICH id drifted.
    expect({ notMirrored, staleMirror }).toEqual({ notMirrored: [], staleMirror: [] });
    expect(new Set(mirrored).size).toBe(mirrored.length); // no id mirrored twice
    expect(new Set(produced)).toEqual(new Set(mirrored));
  });
});
