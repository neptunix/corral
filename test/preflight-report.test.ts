import { describe, it, expect } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import type { MissingBinary, ReportLine } from "../server/preflight.ts";
import { buildReport, checkRegistryDirs, formatReport, loadEnvironmentsOrReport } from "../server/preflight.ts";

const pinned = (id: string): HerdrEnv => ({
  id, label: id.toUpperCase(), kind: "local", socket: `~/.config/herdr/sessions/${id}/herdr.sock`,
  claudeConfigDirs: [], spawnCommand: "claude", repos: {},
});
const unpinned = (id: string): HerdrEnv => ({
  id, label: id.toUpperCase(), kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {},
});
const remote = (id: string): HerdrEnv => ({
  id, label: id.toUpperCase(), kind: "remote", sshHost: "h", socket: "~/s.sock", herdrBin: "herdr",
  claudeConfigDirs: [], spawnCommand: "claude", repos: {},
});

const okLine: ReportLine = { level: "ok", text: "config: 1 environment loaded from /cfg.json" };

/** buildReport input with everything healthy; each test overrides only what it is about. */
function input(over: Partial<Parameters<typeof buildReport>[0]> = {}): Parameters<typeof buildReport>[0] {
  return {
    env: { PATH: "/usr/bin", HERDR_SOCKET_PATH: "/sock" },
    envs: [pinned("work")],
    configLine: okLine,
    missing: [],
    pathEnv: "/usr/bin",
    ...over,
  };
}

const texts = (r: { lines: readonly ReportLine[] }): string =>
  r.lines.map((l) => `${l.text} ${l.detail ?? ""}`).join("\n");

describe("buildReport — the under-Claude rule", () => {
  it("is not fatal when CLAUDECODE is absent", () => {
    expect(buildReport(input()).fatal).toBe(false);
  });

  it("counts CLAUDECODE as set whatever its value — `CLAUDECODE= npm run dev` must not be a silent escape", () => {
    expect(buildReport(input({ env: { CLAUDECODE: "", PATH: "/usr/bin" } })).fatal).toBe(true);
  });

  it("is fatal when CLAUDECODE is set", () => {
    const r = buildReport(input({ env: { CLAUDECODE: "1", HERDR_SOCKET_PATH: "/sock" } }));
    expect(r.fatal).toBe(true);
    expect(texts(r)).toContain("Claude Code");
  });

  it("tells the operator why it refused and how to proceed — the whole point of refusing", () => {
    const detail = buildReport(input({ env: { CLAUDECODE: "1" } })).lines[0]?.detail ?? "";
    expect(detail).toContain("passes its whole environment to every child");
    expect(detail).toContain("CORRAL_ALLOW_UNDER_CLAUDE=1");
    expect(detail).toContain("outside Claude Code");
  });

  it("downgrades to a warning when the override is exactly \"1\"", () => {
    const r = buildReport(input({ env: { CLAUDECODE: "1", CORRAL_ALLOW_UNDER_CLAUDE: "1" } }));
    expect(r.fatal).toBe(false);
    expect(r.lines.some((l) => l.level === "warning" && l.text.includes("CORRAL_ALLOW_UNDER_CLAUDE"))).toBe(true);
  });

  it("stays fatal for CORRAL_ALLOW_UNDER_CLAUDE=0 — the override is an exact match, not presence", () => {
    expect(buildReport(input({ env: { CLAUDECODE: "1", CORRAL_ALLOW_UNDER_CLAUDE: "0" } })).fatal).toBe(true);
  });

  it("says nothing about the guard when the override is set but corral is not under Claude", () => {
    const r = buildReport(input({ env: { CORRAL_ALLOW_UNDER_CLAUDE: "1" } }));
    expect(r.fatal).toBe(false);
    expect(texts(r)).not.toContain("CORRAL_ALLOW_UNDER_CLAUDE");
  });
});

describe("buildReport — the socket consequence is conditional", () => {
  it("names the wrong-fleet consequence when the socket is inherited and an env is unpinned", () => {
    const r = buildReport(input({
      env: { CLAUDECODE: "1", HERDR_SOCKET_PATH: "/sock" },
      envs: [unpinned("local"), pinned("work")],
    }));
    const detail = r.lines[0]?.detail ?? "";
    expect(detail).toContain("would follow this pane's herdr");
    expect(detail).toContain("local");
    expect(detail).not.toContain("work"); // the pinned env must not be blamed
  });

  it("omits it when every local env pins its own socket — there is nothing to inherit", () => {
    const r = buildReport(input({
      env: { CLAUDECODE: "1", HERDR_SOCKET_PATH: "/sock" },
      envs: [pinned("work"), remote("box")],
    }));
    expect(r.fatal).toBe(true);
    expect(texts(r)).not.toContain("would follow this pane's herdr");
  });

  it("omits it when HERDR_SOCKET_PATH is unset — a headless run inherits no socket", () => {
    const r = buildReport(input({ env: { CLAUDECODE: "1" }, envs: [unpinned("local")] }));
    expect(r.fatal).toBe(true);
    expect(texts(r)).not.toContain("would follow this pane's herdr");
  });

  it("omits it when the config never loaded, since nothing is known about the envs", () => {
    const r = buildReport(input({
      env: { CLAUDECODE: "1", HERDR_SOCKET_PATH: "/sock" },
      envs: null,
      configLine: { level: "fatal", text: "config: cannot read /cfg.json" },
    }));
    expect(texts(r)).not.toContain("would follow this pane's herdr");
  });
});

describe("buildReport — socket warnings, both directions", () => {
  it("warns that an unpinned env will follow the ambient socket when one is set", () => {
    const r = buildReport(input({ envs: [unpinned("local")] }));
    expect(r.fatal).toBe(false);
    expect(r.lines.some((l) => l.level === "warning" && l.text.includes("unpinned"))).toBe(true);
  });

  it("treats an empty HERDR_SOCKET_PATH as unset, like CLAUDECODE", () => {
    const r = buildReport(input({ env: { PATH: "/usr/bin", HERDR_SOCKET_PATH: "" }, envs: [unpinned("local")] }));
    expect(r.lines.some((l) => l.text.includes("HERDR_SOCKET_PATH is unset"))).toBe(true);
    expect(texts(r)).not.toContain("from this shell");
  });

  it("keeps the pre-existing warning for an unset HERDR_SOCKET_PATH", () => {
    const r = buildReport(input({ env: { PATH: "/usr/bin" }, envs: [unpinned("local")] }));
    expect(r.lines.some((l) => l.level === "warning" && l.text.includes("HERDR_SOCKET_PATH is unset"))).toBe(true);
  });

  it("says neither when every local env pins a socket", () => {
    const r = buildReport(input({ envs: [pinned("work")] }));
    expect(texts(r)).not.toContain("unpinned");
    expect(texts(r)).not.toContain("HERDR_SOCKET_PATH is unset");
  });
});

describe("buildReport — missing binaries never make it fatal", () => {
  it("reports one ok line when everything resolves", () => {
    const r = buildReport(input());
    expect(r.lines.some((l) => l.level === "ok" && l.text.includes("PATH"))).toBe(true);
  });

  it("warns per missing binary and does NOT exit — a dead board is worse than a degraded one", () => {
    const missing: MissingBinary[] = [{ bin: "herdr", envIds: ["work"] }, { bin: "ssh", envIds: ["box"] }];
    const r = buildReport(input({ missing }));
    expect(r.fatal).toBe(false);
    expect(r.lines.filter((l) => l.level === "warning" && l.text.includes("is not on this server"))).toHaveLength(2);
  });

  it("names only the binaries it actually looked for — an all-local config never checks ssh", () => {
    const r = buildReport(input({ envs: [pinned("work")] }));
    const ok = r.lines.find((l) => l.level === "ok" && l.text.includes("PATH"));
    expect(ok?.text).toContain("herdr");
    expect(ok?.text).not.toContain("ssh");
  });

  it("names ssh too once a remote env needs it", () => {
    const r = buildReport(input({ envs: [pinned("work"), remote("box")] }));
    expect(r.lines.find((l) => l.level === "ok" && l.text.includes("PATH"))?.text).toContain("ssh");
  });

  it("does not claim a clean PATH while also reporting something missing", () => {
    const r = buildReport(input({ missing: [{ bin: "herdr", envIds: ["work"] }] }));
    expect(r.lines.some((l) => l.level === "ok" && l.text.includes("resolved on PATH"))).toBe(false);
  });

  it("emits no binary lines at all when the config failed to load", () => {
    const r = buildReport(input({ envs: null, configLine: { level: "fatal", text: "config: bad" } }));
    expect(texts(r)).not.toContain("PATH");
    expect(r.fatal).toBe(true);
  });
});

describe("loadEnvironmentsOrReport", () => {
  it("turns a thrown config error into a fatal line carrying the message", async () => {
    const res = await loadEnvironmentsOrReport(() => Promise.reject(new Error("bad JSON at line 3")), "/cfg.json");
    expect(res.ok).toBe(false);
    expect(res.line.level).toBe("fatal");
    expect(res.line.text + (res.line.detail ?? "")).toContain("bad JSON at line 3");
  });

  it("passes the loaded environments through and names the config file it opened", async () => {
    const envs = [pinned("work")];
    const res = await loadEnvironmentsOrReport(() => Promise.resolve(envs), "~/custom/environments.json");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.envs).toEqual(envs);
    expect(res.line.text).toContain("~/custom/environments.json"); // verbatim — CORRAL_CONFIG is not expanded
  });
});

describe("formatReport", () => {
  it("renders one marked line per report line", () => {
    const out = formatReport([
      { level: "ok", text: "not running under Claude Code" },
      { level: "warning", text: "env \"local\" is unpinned" },
      { level: "fatal", text: "launched from inside a Claude Code session", detail: "relaunch elsewhere" },
    ]);
    expect(out).toContain("not running under Claude Code");
    expect(out).toContain("env \"local\" is unpinned");
    expect(out).toContain("relaunch elsewhere");
    expect(out.split("\n").length).toBeGreaterThanOrEqual(4); // heading + three lines
  });

  it("marks each line by level — a report that renders every level alike says nothing", () => {
    const out = formatReport([
      { level: "ok", text: "fine" }, { level: "warning", text: "iffy" }, { level: "fatal", text: "broken" },
    ]);
    expect(out).toMatch(/✓ fine/);
    expect(out).toMatch(/⚠ iffy/);
    expect(out).toMatch(/✗ broken/);
    expect(out.split("\n")[0]).toBe("corral preflight");
  });

  it("indents a multi-line detail — every real fatal detail takes that path", () => {
    const out = formatReport([
      { level: "fatal", text: "launched from inside a Claude Code session", detail: "why it matters\n\nfix: do the thing" },
    ]);
    const rendered = out.split("\n").filter((l) => l.includes("why it matters") || l.includes("fix: do the thing"));
    expect(rendered).toHaveLength(2);
    for (const l of rendered) expect(l).toMatch(/^\s{4,}/);
  });

  it("indents every continuation line, so a multi-line Zod error keeps the report's shape", () => {
    const out = formatReport([{ level: "fatal", text: "config: invalid\n  - environments.0.id: required" }]);
    const cont = out.split("\n").filter((l) => l.includes("environments.0.id"));
    expect(cont).toHaveLength(1);
    expect(cont[0]).toMatch(/^\s{4,}/);
  });
});

describe("buildReport — the registry line", () => {
  it("says so once when every environment is readable", () => {
    const r = buildReport(input({ registry: [{ envId: "work", state: "ok", detail: "" }] }));
    expect(texts(r)).toContain("registry readable in every environment");
    expect(r.fatal).toBe(false);
  });

  it("warns per environment, naming the consequence, and never refuses to boot", () => {
    const r = buildReport(input({
      registry: [
        { envId: "work", state: "ok", detail: "" },
        { envId: "box", state: "no-config-dirs", detail: "no \"claudeConfigDirs\" — live session state and Remote Control do not function here" },
      ],
    }));
    expect(texts(r)).toContain('environment "box"');
    expect(texts(r)).toContain("do not function here");
    expect(r.fatal).toBe(false);
    // And the all-clear must NOT also be printed — one degraded environment means the fleet is not
    // uniformly readable, and printing both lines would contradict itself.
    expect(texts(r)).not.toContain("readable in every environment");
  });

  it("emits nothing when the registry was not checked", () => {
    expect(texts(buildReport(input()))).not.toContain("registry");
  });

  it("emits nothing about the registry when the config failed to load", () => {
    // envs: null is the config-failure path; nothing is known, so nothing may be claimed.
    expect(texts(buildReport(input({ envs: null, registry: [{ envId: "work", state: "ok", detail: "" }] }))))
      .not.toContain("registry");
  });
});

describe("checkRegistryDirs", () => {
  it("flags an environment with no config dirs at all", () => {
    const out = checkRegistryDirs([unpinned("bare")], () => true);
    expect(out[0]?.state).toBe("no-config-dirs");
    expect(out[0]?.detail).toContain("do not function here");
  });

  it("flags a local config dir with no sessions/ directory", () => {
    const env: HerdrEnv = { ...unpinned("work"), claudeConfigDirs: ["/home/u/.claude"] };
    expect(checkRegistryDirs([env], () => false)[0]?.state).toBe("unreadable");
    expect(checkRegistryDirs([env], () => true)[0]?.state).toBe("ok");
  });

  it("stats the sessions/ subdirectory, not the config dir itself", () => {
    const seen: string[] = [];
    const env: HerdrEnv = { ...unpinned("work"), claudeConfigDirs: ["/home/u/.claude"] };
    checkRegistryDirs([env], (p) => { seen.push(p); return true; });
    expect(seen).toEqual(["/home/u/.claude/sessions"]);
  });

  it("counts how many of several local dirs are missing", () => {
    const env: HerdrEnv = { ...unpinned("work"), claudeConfigDirs: ["/a", "/b", "/c"] };
    const out = checkRegistryDirs([env], (p) => p === "/a/sessions");
    expect(out[0]?.state).toBe("unreadable");
    expect(out[0]?.detail).toContain("2 of 3 config dir(s)");
  });

  it("does not stat a remote environment", () => {
    let stats = 0;
    const env: HerdrEnv = { ...remote("box"), claudeConfigDirs: ["/home/u/.claude"] };
    expect(checkRegistryDirs([env], () => { stats++; return false; })[0]?.state).toBe("ok");
    expect(stats).toBe(0);
  });

  it("reports one entry per environment, in order", () => {
    const out = checkRegistryDirs([unpinned("a"), remote("b")], () => true);
    expect(out.map((r) => r.envId)).toEqual(["a", "b"]);
  });
});
