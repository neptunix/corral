import type { Snapshot } from "@shared/schema";
import { describe, it, expect } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { createNodeDeps } from "../server/diagnostics/deps.ts";
import { createDiagnosticsStore } from "../server/diagnostics-store.ts";
import { createDiagnosticsSweep, type SweepOpts } from "../server/diagnostics-sweep.ts";

const local = (id: string): HerdrEnv => ({
  id, label: id, kind: "local", claudeConfigDirs: ["/h/.claude"], spawnCommand: "claude", repos: {},
});
const remote = (id: string): HerdrEnv => ({
  id, label: id, kind: "remote", sshHost: "h", socket: "~/s.sock", herdrBin: "herdr",
  claudeConfigDirs: ["/far/.claude"], spawnCommand: "claude", repos: {},
});
const snapshot = (envs: Snapshot["envs"]): Snapshot => ({ envs, sessions: [] });

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
    // Counts PROBE ROUNDS, not concurrent `run` calls: versionChecks fires its three probes through
    // one Promise.all inside a single tick (server/diagnostics/versions.ts), so a concurrency counter
    // over `run` reports an overlap for one lone tick and can say nothing about two. One round from
    // two simultaneous ticks is the property — the mirror image of the refresh test's two.
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
    const second = sweep.tick(); // must collapse onto the run already in flight, not start a second
    release();
    await Promise.all([first, second]);
    expect(probes).toHaveLength(1);
  });
});
