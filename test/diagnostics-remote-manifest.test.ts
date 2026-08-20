import { describe, expect, it } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { ctxHookChecks } from "../server/diagnostics/ctx-hook.ts";
import { STANDARD_BIN_DIRS, pathCandidates } from "../server/diagnostics/deps.ts";
import { DRIFT_FILES, driftCheck, themeCheck } from "../server/diagnostics/drift.ts";
import { jqPresentCheck, configDirExistsChecks } from "../server/diagnostics/env.ts";
import { metricsChecks } from "../server/diagnostics/metrics.ts";
import { buildManifest, PER_DIR_FILES } from "../server/diagnostics/remote/manifest.ts";
import { createDepsRecorder } from "../server/diagnostics/remote/recorder.ts";
import type { FactSource } from "../server/diagnostics/remote/recorder.ts";
import type { ProbeAnswer } from "../server/diagnostics/remote/wire.ts";

const DIR = "/far/.claude";
const DYN = `${DIR}/statusline-command.sh`; // the ONE deliberately-dynamic path (round 2's subject)

const env: HerdrEnv = {
  id: "box", label: "box", kind: "remote", sshHost: "h", socket: "~/s.sock",
  herdrBin: "~/.local/bin/herdr", claudeConfigDirs: [DIR], spawnCommand: "claude", repos: {},
};

const content = (s: string, executable = false): ProbeAnswer =>
  ({ kind: "content", bytes: Buffer.from(s), executable });

/** installed / not-installed / malformed-settings — the matrix the guard runs over. */
const FIXTURES: Record<string, Record<string, ProbeAnswer>> = {
  installed: {
    [`${DIR}/settings.json`]: content(JSON.stringify({
      statusLine: { type: "command", command: DYN },
      theme: "custom:corral",
      hooks: {
        SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: `${DIR}/corral-claude-hook.sh` }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `${DIR}/corral-claude-hook.sh` }] }],
      },
    })),
    [`${DIR}/corral-status-capture.sh`]: content("#!/bin/sh", true),
    [`${DIR}/corral-claude-hook.sh`]: content("#!/bin/sh", true),
    [`${DIR}/skills/corral/SKILL.md`]: content("<!-- ctx-signal:start -->x<!-- ctx-signal:end -->"),
    [`${DIR}/themes/corral.json`]: content("{}"),
    [DYN]: content("corral-status-capture.sh"),
    [DIR]: { kind: "dir", exists: true },
  },
  notInstalled: { [DIR]: { kind: "dir", exists: true } },
  malformedSettings: {
    [`${DIR}/settings.json`]: content("{not json"),
    [`${DIR}/corral-status-capture.sh`]: content("#!/bin/sh", true),
    [`${DIR}/corral-claude-hook.sh`]: content("#!/bin/sh", true),
    [DIR]: { kind: "dir", exists: true },
  },
};

describe("buildManifest", () => {
  it("assigns unique keys and covers dirs, per-dir files, jq candidates, HOME and PATH", () => {
    const m = buildManifest([DIR]);
    const keys = m.entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    const paths = new Set(m.entries.map((e) => e.path));
    expect(paths.has(DIR)).toBe(true);
    for (const rel of PER_DIR_FILES) expect(paths.has(`${DIR}/${rel}`)).toBe(true);
    for (const d of STANDARD_BIN_DIRS) expect(paths.has(`${d}/jq`)).toBe(true);
    expect(paths.has("$HOME")).toBe(true);
    expect(paths.has("$PATH")).toBe(true);
  });
});

describe("the manifest guard — producers' asked paths equal the manifest, over the fixture UNION", () => {
  it("union over installed / not-installed / malformed fixtures equals the manifest exactly", () => {
    const asked = new Set<string>();
    for (const m of Object.values(FIXTURES)) {
      // pathEnv "" keeps PATH-derived jq candidates (round 2's subject) out of the static set.
      const facts: FactSource = { lookup: (p) => m[p], home: "/far", pathEnv: "" };
      const rec = createDepsRecorder(facts, {
        repoRoot: "/repo", nodeVersion: "22.0.0", now: () => 1,
        // Derived from DRIFT_FILES exactly as the adapter does (adapter.ts) — a hand-listed copy
        // silently stops matching the moment a tracked file is added, which is when this guard is
        // most worth having.
        localHashPaths: new Set(DRIFT_FILES.map(([, repo]) => `/repo/${repo}`)),
        localHash: () => "h",
      });
      metricsChecks(rec.deps, env.id, DIR);
      ctxHookChecks(rec.deps, env.id, DIR);
      driftCheck(rec.deps, env.id, DIR);
      themeCheck(rec.deps, env.id, DIR);
      jqPresentCheck(rec.deps, env, 1);
      configDirExistsChecks(rec.deps, env, 1);
      for (const p of rec.asked) asked.add(p);
    }
    const manifest = new Set(buildManifest([DIR]).entries
      .filter((e) => e.kind !== "value").map((e) => e.path));
    // The statusline script is the ONE dynamic subject — named, not silently subtracted.
    const staticAsked = new Set([...asked].filter((p) => p !== DYN));
    const notInManifest = [...staticAsked].filter((p) => !manifest.has(p));
    const notAsked = [...manifest].filter((p) => !staticAsked.has(p));
    expect({ notInManifest, notAsked }).toEqual({ notInManifest: [], notAsked: [] });
  });
});

describe("pathCandidates matches resolveOnPath's split exactly", () => {
  it("skips empty entries, joins with path.join, keeps trailing/doubled-colon behaviour", () => {
    expect(pathCandidates("jq", "/usr/bin::/opt/bin/:")).toEqual(["/usr/bin/jq", "/opt/bin/jq"]);
    expect(pathCandidates("jq", "")).toEqual([]);
  });
});
