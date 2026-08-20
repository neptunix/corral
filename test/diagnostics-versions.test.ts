import type { Check } from "@shared/diagnostics-schema";
import { describe, it, expect } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { parseIntegrationStatus, versionChecks } from "../server/diagnostics/versions.ts";

const local = (id: string, dirs: readonly string[] = ["/h/.claude"]): HerdrEnv => ({
  id, label: id, kind: "local", claudeConfigDirs: dirs, spawnCommand: "claude", repos: {},
});
const byId = (cs: readonly Check[], id: string): Check | undefined => cs.find((c) => c.id === id);
const run = (out: Readonly<Record<string, string | null>>) =>
  (bin: string, args: readonly string[]): Promise<string | null> =>
    Promise.resolve(out[[bin, ...args].join(" ")] ?? null);
const HEALTHY = {
  "herdr --version": "herdr 0.7.5",
  "herdr integration status": "claude: current (v7) (/p)",
  "claude --version": "2.1.232 (Claude Code)",
};

describe("parseIntegrationStatus", () => {
  it("reads the claude line out of the flat text", () => {
    const text = [
      "pi: not installed (/h/.pi/x.ts)",
      "claude: current (v7) (/h/.claude/hooks/herdr-agent-state.sh)",
      "codex: not installed (/h/.codex/x.sh)",
    ].join("\n");
    expect(parseIntegrationStatus(text)).toEqual({ installed: true, current: true, version: "7" });
  });
  it("detects an outdated install", () => {
    expect(parseIntegrationStatus("claude: outdated (v5) (/p)")).toEqual({ installed: true, current: false, version: "5" });
  });
  it("detects an absent install", () => {
    expect(parseIntegrationStatus("claude: not installed (/p)")).toEqual({ installed: false, current: false, version: null });
  });
  it("returns null for text with no claude line — unparseable is not 'not installed'", () => {
    expect(parseIntegrationStatus("pi: current (v3) (/p)")).toBe(null);
    expect(parseIntegrationStatus("")).toBe(null);
  });
});

describe("versionChecks", () => {
  it("files every row under the versions class", async () => {
    const cs = await versionChecks({ envs: [local("work")], run: run(HEALTHY), ccVersionByEnv: {}, now: () => 1 });
    expect(cs.every((c) => c.class === "versions")).toBe(true);
  });

  it("is ok at the floor and above it — there is no upper bound", async () => {
    for (const v of ["0.7.1", "0.7.5", "0.8.0", "1.2.0"]) {
      const cs = await versionChecks({
        envs: [local("work")], ccVersionByEnv: {}, now: () => 1,
        run: run({ ...HEALTHY, "herdr --version": `herdr ${v}` }),
      });
      const c = byId(cs, "herdr-version");
      expect(c?.state).toBe("ok");
    }
  });

  it("warns below the floor and names both versions", async () => {
    const cs = await versionChecks({
      envs: [local("work")], ccVersionByEnv: {}, now: () => 1,
      run: run({ ...HEALTHY, "herdr --version": "herdr 0.7.0" }),
    });
    const c = byId(cs, "herdr-version");
    expect(c?.state).toBe("problem");
    expect(c?.severity).toBe("warning");
    expect(c?.detail).toContain("0.7.1");
    expect(c?.detail).toContain("0.7.0");
  });

  it("warns on an outdated integration and says the attention feed dies without it", async () => {
    const cs = await versionChecks({
      envs: [local("work")], ccVersionByEnv: {}, now: () => 1,
      run: run({ ...HEALTHY, "herdr integration status": "claude: outdated (v5) (/p)" }),
    });
    const c = byId(cs, "herdr-claude-integration");
    expect(c?.severity).toBe("warning");
    expect(c?.detail).toMatch(/attention/i);
  });

  it("goes n/a when a command cannot be run at all", async () => {
    const cs = await versionChecks({ envs: [local("work")], run: run({}), ccVersionByEnv: {}, now: () => 1 });
    expect(byId(cs, "herdr-version")?.state).toBe("n/a");
    expect(byId(cs, "herdr-claude-integration")?.state).toBe("n/a");
  });

  it("goes problem/warning — not n/a — when herdr --version output is unparseable", async () => {
    const cs = await versionChecks({
      envs: [local("work")], ccVersionByEnv: {}, now: () => 1,
      run: run({ ...HEALTHY, "herdr --version": "no digits here" }),
    });
    const c = byId(cs, "herdr-version");
    expect(c?.state).toBe("problem");
    expect(c?.severity).toBe("warning");
    expect(c?.title).toMatch(/could not be read|unparseable/i);
  });

  it("goes problem/warning — not n/a — when the integration output is unparseable", async () => {
    const cs = await versionChecks({
      envs: [local("work")], ccVersionByEnv: {}, now: () => 1,
      run: run({ ...HEALTHY, "herdr integration status": "usage: herdr integration status [--outdated-only]" }),
    });
    const c = byId(cs, "herdr-claude-integration");
    expect(c?.state).toBe("problem");
    expect(c?.severity).toBe("warning");
  });

  it("runs the integration probe once per config dir, with distinct keys", async () => {
    const seen: string[] = [];
    const cs = await versionChecks({
      envs: [local("work", ["/h/.claude", "/h/.claude-x"])], ccVersionByEnv: {}, now: () => 1,
      run: (bin, args, opts) => {
        if (args[0] === "integration") seen.push(opts?.extraEnv?.CLAUDE_CONFIG_DIR ?? "");
        // via run(), not HEALTHY[...]: indexing a const object literal with a computed string is a
        // typecheck error under this repo's settings.
        return run(HEALTHY)(bin, args);
      },
    });
    expect(seen.sort()).toEqual(["/h/.claude", "/h/.claude-x"]);
    const rows = cs.filter((c) => c.id === "herdr-claude-integration");
    expect(new Set(rows.map((c) => c.key)).size).toBe(2);
  });

  it("prefers the local claude --version over the statusline's cc_version", async () => {
    const cs = await versionChecks({
      envs: [local("work")], ccVersionByEnv: { work: "2.0.1" }, now: () => 1, run: run(HEALTHY),
    });
    expect(byId(cs, "claude-cli-version")?.state).toBe("ok");
  });

  it("falls back to cc_version when the CLI cannot be run", async () => {
    const cs = await versionChecks({
      envs: [local("work")], ccVersionByEnv: { work: "2.0.1" }, now: () => 1,
      run: run({ ...HEALTHY, "claude --version": null }),
    });
    const c = byId(cs, "claude-cli-version");
    expect(c?.state).toBe("problem");
    expect(c?.severity).toBe("info");
  });

  it("is n/a when neither source answers", async () => {
    const cs = await versionChecks({
      envs: [local("work")], ccVersionByEnv: { work: null }, now: () => 1,
      run: run({ ...HEALTHY, "claude --version": null }),
    });
    expect(byId(cs, "claude-cli-version")?.state).toBe("n/a");
  });

  it("emits nothing and runs nothing for a remote environment — the remote adapter owns those rows", async () => {
    const ran: string[] = [];
    const cs = await versionChecks({
      envs: [{ id: "box", label: "box", kind: "remote", sshHost: "h", socket: "~/s.sock",
               herdrBin: "herdr", claudeConfigDirs: ["/far/.claude"], spawnCommand: "claude", repos: {} }],
      ccVersionByEnv: {}, now: () => 1,
      run: (bin, args) => { ran.push([bin, ...args].join(" ")); return Promise.resolve(null); },
    });
    expect(ran).toEqual([]);
    expect(cs).toEqual([]);
  });
});
