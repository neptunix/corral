import type { Check } from "@shared/diagnostics-schema";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { STANDARD_BIN_DIRS } from "../server/diagnostics/deps.ts";
import { composeRemoteRows, planRound2For } from "../server/diagnostics/remote/adapter.ts";
import type { RemoteRowsOpts } from "../server/diagnostics/remote/adapter.ts";
import type { ProbeFacts } from "../server/diagnostics/remote/probe.ts";
import { toolCallSignature } from "../server/diagnostics/remote/recorder.ts";
import type { RemoteEnv } from "../server/diagnostics/remote/script.ts";
import type { ProbeAnswer } from "../server/diagnostics/remote/wire.ts";

const REPO_ROOT = "/repo";
const DIR = "/far/.claude";
const DYN = `${DIR}/statusline-command.sh`;

const sha256 = (s: string): string => createHash("sha256").update(Buffer.from(s)).digest("hex");
const content = (s: string, executable = false): ProbeAnswer =>
  ({ kind: "content", bytes: Buffer.from(s), executable });

const CAPTURE_CONTENT = "#!/bin/sh\n# capture";
const HOOK_CONTENT = "#!/bin/sh\n# hook";
const SKILL_CONTENT = "<!-- ctx-signal:start -->x<!-- ctx-signal:end -->";

const remoteEnv = (dirs: readonly string[] = [DIR]): RemoteEnv => ({
  id: "box", label: "box", kind: "remote", sshHost: "h", socket: "~/s.sock",
  herdrBin: "~/.local/bin/herdr", claudeConfigDirs: dirs, spawnCommand: "claude", repos: {},
});

/** Local-side hashes matching CAPTURE_CONTENT/HOOK_CONTENT/SKILL_CONTENT — drift compares clean. */
function healthyLocalHash(p: string): string | null {
  if (p === `${REPO_ROOT}/scripts/corral-status-capture.sh`) return sha256(CAPTURE_CONTENT);
  if (p === `${REPO_ROOT}/scripts/corral-claude-hook.sh`) return sha256(HOOK_CONTENT);
  if (p === `${REPO_ROOT}/skills/corral/SKILL.md`) return sha256(SKILL_CONTENT);
  return null;
}

function settingsJson(statusLineCommand: string): string {
  return JSON.stringify({
    statusLine: { type: "command", command: statusLineCommand },
    theme: "custom:corral",
    hooks: {
      SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: `${DIR}/corral-claude-hook.sh` }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: `${DIR}/corral-claude-hook.sh` }] }],
    },
  });
}

const HEALTHY_BYPATH: readonly (readonly [string, ProbeAnswer])[] = [
  [DIR, { kind: "dir", exists: true }],
  [`${DIR}/settings.json`, content(settingsJson(DYN))],
  [`${DIR}/corral-status-capture.sh`, content(CAPTURE_CONTENT, true)],
  [`${DIR}/corral-claude-hook.sh`, content(HOOK_CONTENT, true)],
  [`${DIR}/skills/corral/SKILL.md`, content(SKILL_CONTENT)],
  [`${DIR}/themes/corral.json`, content("{}")],
  [DYN, content("exec corral-status-capture.sh")],
  ["/usr/bin/jq", { kind: "exec", executable: true }],
];

const HEALTHY_TOOLS = new Map<string, ProbeAnswer>([
  [toolCallSignature("herdr", ["--version"], undefined), { kind: "value", text: "herdr 0.9.0" }],
  [toolCallSignature("claude", ["--version"], undefined), { kind: "value", text: "claude 2.1.240" }],
  [toolCallSignature("herdr", ["integration", "status"], DIR), { kind: "value", text: "claude: current (v6)" }],
]);

function healthyProbe(overrides: Partial<ProbeFacts> = {}): ProbeFacts {
  return {
    byPath: new Map(HEALTHY_BYPATH),
    home: "/home/u",
    pathEnv: "/usr/bin",
    tools: HEALTHY_TOOLS,
    expected: 20,
    arrived: 20,
    error: null,
    ...overrides,
  };
}

function baseOpts(overrides: Partial<RemoteRowsOpts> = {}): RemoteRowsOpts {
  return {
    env: remoteEnv(),
    probe: healthyProbe(),
    reason: null,
    repoRoot: REPO_ROOT,
    nodeVersion: "22.0.0",
    now: () => 1_700_000_000_000,
    localHash: healthyLocalHash,
    ccVersion: null,
    ...overrides,
  };
}

const byId = (cs: readonly Check[], id: string): Check | undefined => cs.find((c) => c.id === id);

const HEALTHY_IDS = [
  "jq-present", "config-dir-exists", "capture-script", "statusline-registered",
  "ctx-hook-installed", "ctx-hook-registered", "corral-skill-installed", "helper-drift",
  "theme-installed", "herdr-version", "claude-cli-version", "herdr-claude-integration",
  "remote-probe",
];

describe("composeRemoteRows — healthy host", () => {
  it("every row is a real ok verdict, filed under remote, and remote-probe is ok", async () => {
    const rows = await composeRemoteRows(baseOpts());
    expect(rows.every((c) => c.class === "remote")).toBe(true);
    for (const id of HEALTHY_IDS) {
      const c = byId(rows, id);
      expect(c?.state, `${id} should be ok`).toBe("ok");
    }
    const ids = rows.map((c) => c.id).sort();
    expect(ids).toEqual([...HEALTHY_IDS].sort());
    const keys = rows.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names every subject in HEALTHY_IDS and nothing else — no duplicates, no stray rows", async () => {
    const rows = await composeRemoteRows(baseOpts());
    expect(rows).toHaveLength(HEALTHY_IDS.length);
  });

  it("remote-probe row is always severity warning even when ok", async () => {
    const rows = await composeRemoteRows(baseOpts());
    expect(byId(rows, "remote-probe")?.severity).toBe("warning");
  });
});

describe("composeRemoteRows — tool tokens (the RunTool seam, pinned end-to-end)", () => {
  it("a distinct herdrBin config token still resolves via the LITERAL toolCallSignature", async () => {
    const rows = await composeRemoteRows(baseOpts({
      env: { ...remoteEnv(), herdrBin: "~/.local/bin/herdr" },
    }));
    const c = byId(rows, "herdr-version");
    expect(c?.state).toBe("ok");
    expect(c?.title).toContain("0.9.0");
  });
});

describe("composeRemoteRows — partial probe", () => {
  it("removing SKILL.md rewrites ctx-hook's three rows (over-drop) and any other call sharing that path", async () => {
    const byPath = new Map(HEALTHY_BYPATH);
    byPath.delete(`${DIR}/skills/corral/SKILL.md`);
    const rows = await composeRemoteRows(baseOpts({ probe: healthyProbe({ byPath, arrived: 19 }) }));

    for (const id of ["ctx-hook-installed", "ctx-hook-registered", "corral-skill-installed"]) {
      const c = byId(rows, id);
      expect(c?.state, `${id} should be rewritten n/a`).toBe("n/a");
      expect(c?.detail).toBe("");
      expect(c?.title).toContain("not known this round");
    }
    // skills/corral/SKILL.md is itself one of DRIFT_FILES' tracked files, so helper-drift's OWN
    // call reads the identical unanswered path — the shared-path instance of the same over-drop,
    // not just intra-call. Calls that never touch this path stay real.
    expect(byId(rows, "helper-drift")?.state).toBe("n/a");
    for (const id of ["capture-script", "statusline-registered", "theme-installed", "jq-present", "config-dir-exists"]) {
      expect(byId(rows, id)?.state, `${id} should keep its real answer`).toBe("ok");
    }

    const probeRow = byId(rows, "remote-probe");
    expect(probeRow?.state).toBe("problem");
    expect(probeRow?.severity).toBe("warning");
    expect(probeRow?.title).toContain("corral-skill-installed");
    expect(probeRow?.title).not.toMatch(/f_\d/); // never an opaque wire key
  });

  it("rewritten rows are present, not dropped — row count matches the healthy case", async () => {
    const byPath = new Map(HEALTHY_BYPATH);
    byPath.delete(`${DIR}/skills/corral/SKILL.md`);
    const rows = await composeRemoteRows(baseOpts({ probe: healthyProbe({ byPath, arrived: 19 }) }));
    expect(rows).toHaveLength(HEALTHY_IDS.length);
  });

  it("a call that never touches the missing path keeps its real answer (own-call isolation)", async () => {
    // themes/corral.json is read ONLY by themeCheck — no other producer, no DRIFT_FILES entry.
    const byPath = new Map(HEALTHY_BYPATH);
    byPath.delete(`${DIR}/themes/corral.json`);
    const rows = await composeRemoteRows(baseOpts({ probe: healthyProbe({ byPath, arrived: 19 }) }));
    expect(byId(rows, "theme-installed")?.state).toBe("n/a");
    for (const id of ["helper-drift", "ctx-hook-installed", "ctx-hook-registered", "corral-skill-installed", "capture-script", "statusline-registered"]) {
      expect(byId(rows, id)?.state, `${id} should keep its real answer`).toBe("ok");
    }
  });
});

describe("composeRemoteRows — the RunTool seam rewrite", () => {
  it("a missing integration tool signature rewrites herdr-claude-integration, distinct from a genuine n/a", async () => {
    const tools = new Map(HEALTHY_TOOLS);
    tools.delete(toolCallSignature("herdr", ["integration", "status"], DIR));
    const rows = await composeRemoteRows(baseOpts({ probe: healthyProbe({ tools, arrived: 19 }) }));
    const c = byId(rows, "herdr-claude-integration");
    expect(c?.state).toBe("n/a");
    expect(c?.title).toContain("not known this round");
    expect(c?.title).not.toMatch(/could not be run/);
    expect(c?.detail).toBe("");
    const probeRow = byId(rows, "remote-probe");
    expect(probeRow?.state).toBe("problem");
    expect(probeRow?.title).toContain("herdr-claude-integration");
  });
});

describe("composeRemoteRows — whole failure (R17)", () => {
  it("every row is n/a and remote-probe is n/a (never problem), title carries the error", async () => {
    const rows = await composeRemoteRows(baseOpts({
      probe: { byPath: new Map(), home: null, pathEnv: null, tools: new Map(), expected: 20, arrived: 0, error: "ssh: connect refused" },
    }));
    for (const id of HEALTHY_IDS) {
      if (id === "remote-probe") continue;
      const c = byId(rows, id);
      expect(c?.state, `${id} should be n/a`).toBe("n/a");
      expect(c?.class).toBe("remote");
    }
    const probeRow = byId(rows, "remote-probe");
    expect(probeRow?.state).toBe("n/a");
    expect(probeRow?.severity).toBe("warning");
    expect(probeRow?.title).toContain("ssh: connect refused");
  });

  it("an empty-string probe.error is still an error — checked by !== null, not truthiness", async () => {
    const rows = await composeRemoteRows(baseOpts({
      probe: { byPath: new Map(), home: null, pathEnv: null, tools: new Map(), expected: 20, arrived: 0, error: "" },
    }));
    const probeRow = byId(rows, "remote-probe");
    expect(probeRow?.state).toBe("n/a");
    expect(probeRow?.title).toBe('remote probe failed for "box": ');
  });
});

describe("composeRemoteRows — disabled (no probe)", () => {
  it("same full row set, all n/a, remote-probe n/a titled with the reason — no exec, no disk", async () => {
    let localHashCalls = 0;
    const opts = baseOpts({
      probe: null,
      reason: "probe disabled (REMOTE_PROBE_ENABLED=false)",
      localHash: () => { localHashCalls += 1; return null; }, // stub only — never touches real disk
    });
    const rows = await composeRemoteRows(opts);
    const ids = rows.map((c) => c.id).sort();
    expect(ids).toEqual([...HEALTHY_IDS].sort());
    for (const c of rows) {
      expect(c.state).toBe("n/a");
      expect(c.class).toBe("remote");
    }
    const probeRow = byId(rows, "remote-probe");
    expect(probeRow?.title).toBe("probe disabled (REMOTE_PROBE_ENABLED=false)");
    expect(localHashCalls).toBeGreaterThan(0); // called, but only the injected stub — no real I/O
  });
});

describe("composeRemoteRows — hashFile routing", () => {
  it("localHash is called for exactly the three DRIFT_FILES repo paths and nothing else", async () => {
    const calls: string[] = [];
    const opts = baseOpts({ localHash: (p) => { calls.push(p); return healthyLocalHash(p); } });
    await composeRemoteRows(opts);
    expect(new Set(calls)).toEqual(new Set([
      `${REPO_ROOT}/scripts/corral-status-capture.sh`,
      `${REPO_ROOT}/scripts/corral-claude-hook.sh`,
      `${REPO_ROOT}/skills/corral/SKILL.md`,
    ]));
  });

  it("a remote dir prefix-extending repoRoot stays remote — drift reaches a real verdict", async () => {
    const oddDir = `${REPO_ROOT}-config/.claude`;
    const byPath = new Map<string, ProbeAnswer>([
      [oddDir, { kind: "dir", exists: true }],
      [`${oddDir}/settings.json`, content(settingsJson(`${oddDir}/statusline-command.sh`))],
      [`${oddDir}/corral-status-capture.sh`, content(CAPTURE_CONTENT, true)],
      [`${oddDir}/corral-claude-hook.sh`, content(HOOK_CONTENT, true)],
      [`${oddDir}/skills/corral/SKILL.md`, content(SKILL_CONTENT)],
      [`${oddDir}/themes/corral.json`, content("{}")],
      [`${oddDir}/statusline-command.sh`, content("exec corral-status-capture.sh")],
      ["/usr/bin/jq", { kind: "exec", executable: true }],
    ]);
    let localCalled = 0;
    const rows = await composeRemoteRows(baseOpts({
      env: remoteEnv([oddDir]),
      probe: healthyProbe({ byPath, arrived: 20 }),
      localHash: (p) => { localCalled += 1; return healthyLocalHash(p); },
    }));
    expect(localCalled).toBe(3); // routed local for the exact repoRoot paths only
    const drift = byId(rows, "helper-drift");
    expect(drift?.state === "ok" || drift?.state === "problem").toBe(true); // a REAL verdict, not n/a
  });
});

describe("composeRemoteRows — bytes not text", () => {
  it("SKILL.md differing by one non-UTF8 byte is detected as drift; identical bytes are ok", async () => {
    const badBytes = Buffer.from([0x68, 0x69, 0xff]);
    const goodBytes = Buffer.from([0x68, 0x69, 0x00]);
    const localHash = (p: string): string | null => {
      if (p === `${REPO_ROOT}/skills/corral/SKILL.md`) return createHash("sha256").update(goodBytes).digest("hex");
      return healthyLocalHash(p);
    };
    const withDrift = new Map(HEALTHY_BYPATH);
    withDrift.set(`${DIR}/skills/corral/SKILL.md`, { kind: "content", bytes: badBytes, executable: false });
    const driftRows = await composeRemoteRows(baseOpts({ probe: healthyProbe({ byPath: withDrift }), localHash }));
    expect(byId(driftRows, "helper-drift")?.state).toBe("problem");

    const withoutDrift = new Map(HEALTHY_BYPATH);
    withoutDrift.set(`${DIR}/skills/corral/SKILL.md`, { kind: "content", bytes: goodBytes, executable: false });
    const okRows = await composeRemoteRows(baseOpts({ probe: healthyProbe({ byPath: withoutDrift }), localHash }));
    expect(byId(okRows, "helper-drift")?.state).toBe("ok");
  });
});

describe("composeRemoteRows — jq verdict matrix", () => {
  const jqPath = (dir: string): string => `${dir}/jq`;
  const allStandardDirsNegative = (except?: { dir: string; answer: ProbeAnswer }): [string, ProbeAnswer][] =>
    STANDARD_BIN_DIRS.map((d): [string, ProbeAnswer] =>
      except?.dir === d ? [jqPath(d), except.answer] : [jqPath(d), { kind: "absent" }]);

  it("PATH answered /usr/bin + jq executable there → ok on PATH", async () => {
    const byPath = new Map(HEALTHY_BYPATH); // already has /usr/bin/jq exec:true, pathEnv /usr/bin
    const rows = await composeRemoteRows(baseOpts({ probe: healthyProbe({ byPath }) }));
    const c = byId(rows, "jq-present");
    expect(c?.state).toBe("ok");
    expect(c?.title).toMatch(/resolved on PATH/);
  });

  it("jq only via STANDARD_BIN_DIRS → ok outside PATH", async () => {
    const byPath = new Map(HEALTHY_BYPATH);
    byPath.delete("/usr/bin/jq");
    byPath.set("/nonexistent/jq", { kind: "absent" });
    const standardDir = STANDARD_BIN_DIRS[0];
    if (standardDir === undefined) throw new Error("STANDARD_BIN_DIRS must not be empty");
    for (const [p, a] of allStandardDirsNegative({ dir: standardDir, answer: { kind: "exec", executable: true } })) {
      byPath.set(p, a);
    }
    const rows = await composeRemoteRows(baseOpts({
      probe: healthyProbe({ byPath, pathEnv: "/nonexistent" }),
    }));
    const c = byId(rows, "jq-present");
    expect(c?.state).toBe("ok");
    expect(c?.title).toMatch(/outside this server's PATH/);
  });

  it("PATH unanswered (pathEnv null) → jq-present rewritten n/a", async () => {
    const rows = await composeRemoteRows(baseOpts({
      probe: healthyProbe({ pathEnv: null, arrived: 19 }),
    }));
    const c = byId(rows, "jq-present");
    expect(c?.state).toBe("n/a");
    expect(c?.title).toContain("not known this round");
  });

  it("everything answered-negative → a REAL problem (fatal), the false-red guard cuts the other way", async () => {
    const byPath = new Map(HEALTHY_BYPATH);
    byPath.delete("/usr/bin/jq");
    byPath.set("/usr/bin/jq", { kind: "absent" });
    for (const [p, a] of allStandardDirsNegative()) byPath.set(p, a);
    const rows = await composeRemoteRows(baseOpts({ probe: healthyProbe({ byPath }) }));
    const c = byId(rows, "jq-present");
    expect(c?.state).toBe("problem");
    expect(c?.severity).toBe("fatal");
  });
});

describe("composeRemoteRows — empty answered PATH", () => {
  it('pathEnv: "" (answered) with every STANDARD_BIN_DIRS entry negative → a REAL problem, not n/a', async () => {
    const byPath = new Map(HEALTHY_BYPATH);
    byPath.delete("/usr/bin/jq");
    for (const d of STANDARD_BIN_DIRS) byPath.set(`${d}/jq`, { kind: "absent" });
    const rows = await composeRemoteRows(baseOpts({ probe: healthyProbe({ byPath, pathEnv: "" }) }));
    const c = byId(rows, "jq-present");
    expect(c?.state).toBe("problem");
    expect(c?.severity).toBe("fatal");
  });
});

describe("planRound2For", () => {
  it("derives jq candidates with pathCandidates — trailing/doubled colon splits identically", () => {
    const planner = planRound2For(remoteEnv([]));
    const { requests } = planner({ byPath: new Map(), home: null, pathEnv: "/usr/bin::/opt/bin/:" });
    expect(requests.map((r) => r.path)).toEqual(["/usr/bin/jq", "/opt/bin/jq"]);
    expect(requests.every((r) => r.kind === "exec")).toBe(true);
  });

  it("resolves a statusline path against remote HOME: ~/x.sh + home /far → /far/x.sh", () => {
    const planner = planRound2For(remoteEnv([DIR]));
    const byPath = new Map<string, ProbeAnswer>([
      [`${DIR}/settings.json`, content(JSON.stringify({ statusLine: { type: "command", command: "~/x.sh" } }))],
    ]);
    const { requests, rejected } = planner({ byPath, home: "/far", pathEnv: null });
    expect(requests).toEqual([{ key: "r2_0", kind: "file", path: "/far/x.sh" }]);
    expect(rejected).toEqual([]);
  });

  it("skips an empty command and a relative path into rejected", () => {
    const planner = planRound2For(remoteEnv([DIR]));
    const emptyByPath = new Map<string, ProbeAnswer>([
      [`${DIR}/settings.json`, content(JSON.stringify({ statusLine: { type: "command", command: "   " } }))],
    ]);
    const empty = planner({ byPath: emptyByPath, home: "/far", pathEnv: null });
    expect(empty.requests).toEqual([]);
    expect(empty.rejected).toEqual([{ path: "", reason: "not an absolute path" }]);

    const relByPath = new Map<string, ProbeAnswer>([
      [`${DIR}/settings.json`, content(JSON.stringify({ statusLine: { type: "command", command: "relative.sh" } }))],
    ]);
    const rel = planner({ byPath: relByPath, home: "/far", pathEnv: null });
    expect(rel.requests).toEqual([]);
    expect(rel.rejected).toEqual([{ path: "relative.sh", reason: "not an absolute path" }]);
  });

  it("screens a metacharacter statusline path into rejected", () => {
    const planner = planRound2For(remoteEnv([DIR]));
    const byPath = new Map<string, ProbeAnswer>([
      [`${DIR}/settings.json`, content(JSON.stringify({ statusLine: { type: "command", command: "/tmp/$(x).sh" } }))],
    ]);
    const { requests, rejected } = planner({ byPath, home: null, pathEnv: null });
    expect(requests).toEqual([]);
    expect(rejected).toEqual([{ path: "/tmp/$(x).sh", reason: "failed the metacharacter screen" }]);
  });

  it("accepts a PATH entry with a space (macOS 'Application Support'-shaped dirs)", () => {
    // pathCandidates joins each colon-separated PATH entry with path.join — no whitespace
    // tokenization, unlike resolveCommandPath — so a space-bearing PATH dir survives intact.
    const planner = planRound2For(remoteEnv([]));
    const { requests, rejected } = planner({ byPath: new Map(), home: null, pathEnv: "/opt/my apps/bin" });
    expect(requests).toEqual([{ key: "r2_0", kind: "exec", path: "/opt/my apps/bin/jq" }]);
    expect(rejected).toEqual([]);
  });
});

describe("n/a rewrite titles obey constraint 7 — reason entirely in title, detail empty", () => {
  it("a rewritten row's detail is empty and its title names the env and the reason", async () => {
    const byPath = new Map(HEALTHY_BYPATH);
    byPath.delete(`${DIR}/themes/corral.json`);
    const rows = await composeRemoteRows(baseOpts({ probe: healthyProbe({ byPath, arrived: 19 }) }));
    const c = byId(rows, "theme-installed");
    expect(c?.detail).toBe("");
    expect(c?.title).toContain('for "box"');
    expect(c?.title).toContain("not known this round");
  });
});
