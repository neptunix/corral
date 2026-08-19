import type { Snapshot } from "@shared/schema";
import { describe, it, expect, vi } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { createNodeDeps } from "../server/diagnostics/deps.ts";
import { buildManifest } from "../server/diagnostics/remote/manifest.ts";
import type { ProbeManifest } from "../server/diagnostics/remote/manifest.ts";
import { buildRoundT } from "../server/diagnostics/remote/script.ts";
import type { RemoteEnv, ToolRequest } from "../server/diagnostics/remote/script.ts";
import type { CacheEntry } from "../server/diagnostics/update/cache.ts";
import type { UpdateCheckIo } from "../server/diagnostics/update/check.ts";
import type { FetchFn } from "../server/diagnostics/update/github.ts";
import type { DiagnosticsStore } from "../server/diagnostics-store.ts";
import { createDiagnosticsStore } from "../server/diagnostics-store.ts";
import { createDiagnosticsSweep, type SweepOpts } from "../server/diagnostics-sweep.ts";
import type { ExecFn } from "../server/herdr.ts";

const local = (id: string): HerdrEnv => ({
  id, label: id, kind: "local", claudeConfigDirs: ["/h/.claude"], spawnCommand: "claude", repos: {},
});
const remoteEnvFixture = (id: string, sshHost = "h"): RemoteEnv => ({
  id, label: id, kind: "remote", sshHost, socket: "~/s.sock", herdrBin: "herdr",
  claudeConfigDirs: ["/far/.claude"], spawnCommand: "claude", repos: {},
});
const remote = (id: string, sshHost = "h"): HerdrEnv => remoteEnvFixture(id, sshHost);
const snapshot = (envs: Snapshot["envs"]): Snapshot => ({ envs, sessions: [] });

const b64 = (s: string): string => Buffer.from(s).toString("base64");

/** Answers every manifest subject POSITIVELY — a live, fully healthy remote host. */
function healthyCannedF(manifest: ProbeManifest): string {
  const lines: string[] = [];
  for (const e of manifest.entries) {
    if (e.key === manifest.homeKey) lines.push(`${e.key}\tv:${b64("/home/u")}`);
    else if (e.key === manifest.pathKey) lines.push(`${e.key}\tv:${b64("")}`);
    else if (e.kind === "dir") lines.push(`${e.key}\t!dir`);
    else if (e.kind === "exec") lines.push(`${e.key}\t!exec`);
    else if (e.path.endsWith("/settings.json")) lines.push(`${e.key}\tf:${b64("{}")}`);
    else lines.push(`${e.key}\t!absent`);
  }
  return lines.join("\n");
}

function cannedT(tools: readonly ToolRequest[]): string {
  return tools.map((t) => `${t.key}\tv:${b64(t.signature.startsWith("herdr --version") ? "1.2.3" : "ok")}`).join("\n");
}

/**
 * A healthy fake SSH transport for one remote env — routes by literal script/host text the same way
 * Task 7's probe fixture does (`args[5]`), copied locally rather than shared: this file only needs a
 * "fully answered" variant, not the whole failure-mode matrix `diagnostics-remote-probe.test.ts` covers.
 */
function healthyExec(env: RemoteEnv): ExecFn {
  const manifest = buildManifest(env.claudeConfigDirs);
  const roundT = buildRoundT(env);
  return (_file, args) => {
    const cmd = args[5] ?? "";
    if (cmd.includes("integration status")) return Promise.resolve({ stdout: cannedT(roundT.tools), stderr: "" });
    return Promise.resolve({ stdout: healthyCannedF(manifest), stderr: "" });
  };
}

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

/** No network, no disk: any request from a sweep test is a bug in the sweep, not a fixture gap. */
const inertUpdateIo: UpdateCheckIo = {
  enabled: false, version: "0.0.0", repoSlug: () => null,
  fetch: () => { throw new Error("no request in tests"); },
  cache: { read: () => null, write: () => undefined, degraded: () => null },
};

const opts = (over: Partial<SweepOpts>): SweepOpts => ({
  store: createDiagnosticsStore({ selfVersion: "0.0.0" }),
  poller: { getSnapshot: () => snapshot({ work: { reachable: true } }) },
  envs: [local("work")],
  deps: createNodeDeps({ repoRoot: "/repo" }),
  corralHome: "/h/.corral",
  configLine: { level: "ok", text: "config: 1 environment(s) loaded from /cfg.json" },
  run: () => Promise.resolve(null),
  intervalMs: 60_000, versionTtlMs: 600_000,
  probeExec: () => Promise.reject(new Error("no ssh in tests")), remoteProbeEnabled: true,
  updateIo: inertUpdateIo,
  ...over,
});

describe("createDiagnosticsSweep", () => {
  it("fills every class on the first tick", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const sweep = createDiagnosticsSweep(opts({ store }));
    await sweep.tick();
    expect(store.snapshot().answered.sort()).toEqual(["cheap", "network", "remote", "versions"]);
  });

  it("publishes the remote class unconditionally — an all-local fleet still answers it", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const sweep = createDiagnosticsSweep(opts({ store })); // envs: [local("work")]
    await sweep.tick();
    expect(store.snapshot().answered.sort()).toEqual(["cheap", "network", "remote", "versions"]);
    expect(store.snapshot().checks.filter((c) => c.class === "remote")).toEqual([]);
  });

  it("a probed remote environment publishes real rows under class remote", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const env = remoteEnvFixture("box");
    const sweep = createDiagnosticsSweep(opts({
      store, envs: [env],
      poller: { getSnapshot: () => snapshot({ box: { reachable: true } }) },
      probeExec: healthyExec(env),
    }));
    await sweep.tick();
    const jq = store.snapshot().checks.find((c) => c.key === "jq-present@box");
    expect(jq).toBeDefined();
    expect(jq?.class).toBe("remote");
    expect(jq?.state).not.toBe("pending");
  });

  it("a dead remote host still publishes a FULL n/a row set and remote-probe n/a — and lastError stays null", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const sweep = createDiagnosticsSweep(opts({
      store, envs: [remote("box")],
      poller: { getSnapshot: () => snapshot({ box: { reachable: true } }) },
      probeExec: () => Promise.reject(new Error("ssh: connect to host h port 22: unreachable")),
    }));
    await sweep.tick();
    const remoteRows = store.snapshot().checks.filter((c) => c.class === "remote");
    expect(remoteRows.length).toBeGreaterThan(0);
    expect(remoteRows.every((c) => c.state === "n/a")).toBe(true);
    const probeRow = remoteRows.find((c) => c.id === "remote-probe");
    expect(probeRow?.state).toBe("n/a");
    expect(store.snapshot().lastError).toBe(null);
  });

  it("one dead remote env does not take the other's rows or the cheap rows", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const h1 = remoteEnvFixture("h1", "host1");
    const h2 = remoteEnvFixture("h2", "host2");
    const exec1 = healthyExec(h1);
    const probeExec: ExecFn = (file, args, options) =>
      args[4] === "host2" ? Promise.reject(new Error("ssh: connect to host2: unreachable")) : exec1(file, args, options);
    const sweep = createDiagnosticsSweep(opts({
      store, envs: [local("work"), h1, h2],
      poller: { getSnapshot: () => snapshot({ work: { reachable: true }, h1: { reachable: true }, h2: { reachable: true } }) },
      probeExec,
    }));
    await sweep.tick();
    const checks = store.snapshot().checks;
    expect(checks.find((c) => c.key === "jq-present@h1")?.state).not.toBe("n/a");
    expect(checks.find((c) => c.key === "jq-present@h2")?.state).toBe("n/a");
    expect(checks.some((c) => c.class === "cheap")).toBe(true);
  });

  it("honours the 30-minute TTL on tick and the 60-second floor on refresh", async () => {
    let now = 0;
    let execCalls = 0;
    const env = remoteEnvFixture("box");
    const baseExec = healthyExec(env);
    const probeExec: ExecFn = (file, args, options) => { execCalls += 1; return baseExec(file, args, options); };
    const sweep = createDiagnosticsSweep(opts({
      envs: [env],
      poller: { getSnapshot: () => snapshot({ box: { reachable: true } }) },
      probeExec,
      deps: { ...createNodeDeps({ repoRoot: "/repo" }), now: () => now },
    }));
    await sweep.tick(); // cache miss: probes
    const afterFirstTick = execCalls;
    expect(afterFirstTick).toBeGreaterThan(0);
    await sweep.tick(); // within TTL: cached
    expect(execCalls).toBe(afterFirstTick);
    await sweep.refresh(); // within the 60s floor: still cached
    expect(execCalls).toBe(afterFirstTick);
    now += 61_000;
    await sweep.refresh(); // past the floor: probes again
    expect(execCalls).toBeGreaterThan(afterFirstTick);
    const afterFloorRefresh = execCalls;
    now += 30 * 60_000; // well past the 30-minute TTL
    await sweep.tick();
    expect(execCalls).toBeGreaterThan(afterFloorRefresh);
  });

  it("a FAILED probe retries after 5 minutes, not 30", async () => {
    let now = 0;
    let execCalls = 0;
    const probeExec: ExecFn = () => { execCalls += 1; return Promise.reject(new Error("down")); };
    const sweep = createDiagnosticsSweep(opts({
      envs: [remote("box")],
      poller: { getSnapshot: () => snapshot({ box: { reachable: true } }) },
      probeExec,
      deps: { ...createNodeDeps({ repoRoot: "/repo" }), now: () => now },
    }));
    await sweep.tick();
    const first = execCalls;
    expect(first).toBeGreaterThan(0);
    now += 2 * 60_000; // 2 minutes: inside the 5-minute failure TTL
    await sweep.tick();
    expect(execCalls).toBe(first);
    now += 4 * 60_000; // 6 minutes total: past the 5-minute failure TTL, well under 30
    await sweep.tick();
    expect(execCalls).toBeGreaterThan(first);
  });

  it("remoteProbeEnabled: false composes n/a rows naming the switch and never touches the exec", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const sweep = createDiagnosticsSweep(opts({
      store, envs: [remote("box")], remoteProbeEnabled: false,
      poller: { getSnapshot: () => snapshot({ box: { reachable: true } }) },
      probeExec: () => { throw new Error("must not be called"); },
    }));
    await sweep.tick();
    const probeRow = store.snapshot().checks.find((c) => c.id === "remote-probe");
    expect(probeRow?.state).toBe("n/a");
    expect(probeRow?.title).toContain("REMOTE_PROBE_ENABLED");
  });

  it("produces no duplicate keys with a probed remote environment in the fleet", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const env = remoteEnvFixture("box");
    const sweep = createDiagnosticsSweep(opts({
      store, envs: [local("work"), env],
      poller: { getSnapshot: () => snapshot({ work: { reachable: true }, box: { reachable: true } }) },
      probeExec: healthyExec(env),
    }));
    await sweep.tick();
    const keys = store.snapshot().checks.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("DIAGNOSTICS_INTERVAL_MS=0 is NOT an off switch — a Recheck still sweeps and probes", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    let execCalls = 0;
    const env = remoteEnvFixture("box");
    const baseExec = healthyExec(env);
    const probeExec: ExecFn = (file, args, options) => { execCalls += 1; return baseExec(file, args, options); };
    const sweep = createDiagnosticsSweep(opts({
      store, intervalMs: 0, envs: [env],
      poller: { getSnapshot: () => snapshot({ box: { reachable: true } }) },
      probeExec,
    }));
    // never call start(): the unauthenticated refresh route must still run a full sweep.
    await sweep.refresh();
    expect(execCalls).toBeGreaterThan(0);
    expect(store.snapshot().checks.some((c) => c.class === "remote")).toBe(true);
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

  it("emits no per-dir rows for a remote environment from the cheap sweep — the remote class owns them", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const sweep = createDiagnosticsSweep(opts({
      store, envs: [remote("box")],
      poller: { getSnapshot: () => snapshot({ box: { reachable: true } }) },
    }));
    await sweep.tick();
    // Filter by CLASS, not just scope: from Task 12 on, the remote CLASS legitimately publishes
    // configDir-scoped rows for this env — this test pins the cheap sweep only, and must stay
    // green through that change.
    const rows = store.snapshot().checks.filter((c) => c.class === "cheap" && c.scope.kind === "configDir");
    expect(rows).toEqual([]);
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

  it("keeps a remote environment OUT of the unreachable set — its rows are never collapsed to env-unrunnable", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const sweep = createDiagnosticsSweep(opts({
      store, envs: [local("work"), remote("box")],
      poller: { getSnapshot: () => snapshot({ work: { reachable: true }, box: { reachable: false, error: "down" } }) },
    }));
    await sweep.tick();
    const unrunnable = store.snapshot().checks.filter((c) => c.id === "env-unrunnable");
    expect(unrunnable).toEqual([]); // box is remote: nothing suppressed, no summary row
  });

  it("still collapses an unreachable LOCAL environment exactly as today", async () => {
    const store = createDiagnosticsStore({ selfVersion: null });
    const sweep = createDiagnosticsSweep(opts({
      store, envs: [local("down-env")],
      poller: { getSnapshot: () => snapshot({ "down-env": { reachable: false, error: "x" } }) },
    }));
    await sweep.tick();
    const unrunnable = store.snapshot().checks.filter((c) => c.id === "env-unrunnable");
    expect(unrunnable).toHaveLength(1);
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

describe("the network class", () => {
  const releaseIo = (url: string): UpdateCheckIo => ({
    ...inertUpdateIo, enabled: true, version: "0.6.8",
    repoSlug: () => ({ owner: "neptunix", repo: "corral" }),
    fetch: () => Promise.resolve(new Response(JSON.stringify({ tag_name: "v0.7.0", html_url: url }))),
  });

  it("answers even with the update check off, in ONE put that never blanks a live row", async () => {
    const puts: string[] = [];
    const inner = createDiagnosticsStore({ selfVersion: "0.6.8" });
    const store: DiagnosticsStore = {
      put: (cls, checks) => { puts.push(cls); inner.put(cls, checks); },
      patchSelf: (patch) => { inner.patchSelf(patch); },
      setLastError: (message) => { inner.setLastError(message); },
      snapshot: () => inner.snapshot(),
    };
    await createDiagnosticsSweep(opts({ store })).tick();
    expect(puts.filter((c) => c === "network")).toHaveLength(1);
    const row = inner.snapshot().checks.find((c) => c.id === "update-check");
    expect(row?.state).toBe("n/a");
    expect(row?.title).toContain("UPDATE_CHECK_ENABLED");
  });

  it("patches self from the producer, so the store holds only what the producer validated", async () => {
    const store = createDiagnosticsStore({ selfVersion: "0.6.8" });
    const url = "https://github.com/neptunix/corral/releases/tag/v0.7.0";
    await createDiagnosticsSweep(opts({ store, updateIo: releaseIo(url) })).tick();
    expect(store.snapshot().self).toEqual({ version: "0.6.8", latest: "0.7.0", releaseUrl: url });
  });

  it("leaves self null when the producer refuses the release link", async () => {
    const store = createDiagnosticsStore({ selfVersion: "0.6.8" });
    const io = releaseIo("https://github.com/attacker/corral/releases/tag/v0.7.0");
    await createDiagnosticsSweep(opts({ store, updateIo: io })).tick();
    expect(store.snapshot().self).toEqual({ version: "0.6.8", latest: null, releaseUrl: null });
    expect(store.snapshot().checks.find((c) => c.id === "update-check")?.state).toBe("n/a");
  });

  it("a Recheck does not bypass the cache — the refresh route is unauthenticated", async () => {
    const url = "https://github.com/neptunix/corral/releases/tag/v0.7.0";
    let held: CacheEntry | null = null;
    const fetchFn = vi.fn<FetchFn>(
      () => Promise.resolve(new Response(JSON.stringify({ tag_name: "v0.7.0", html_url: url }))));
    const sweep = createDiagnosticsSweep(opts({
      updateIo: {
        ...releaseIo(url), fetch: fetchFn,
        cache: { read: () => held, write: (_slug, e) => { held = e; }, degraded: () => null },
      },
    }));
    await sweep.tick();
    await sweep.refresh();
    await sweep.refresh();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a failing update check does not take the sweep, or any other class, down", async () => {
    const store = createDiagnosticsStore({ selfVersion: "0.6.8" });
    const io: UpdateCheckIo = {
      ...inertUpdateIo, enabled: true, fetch: () => { throw new Error("boom"); },
    };
    await createDiagnosticsSweep(opts({ store, updateIo: io })).tick();
    expect(store.snapshot().lastError).toBe(null);
    expect(store.snapshot().answered.sort()).toEqual(["cheap", "network", "remote", "versions"]);
  });
});
