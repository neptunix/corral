import type { Check } from "@shared/diagnostics-schema";
import { describe, it, expect } from "vitest";

import type { CheckDeps } from "../server/diagnostics/deps.ts";
import { metricsChecks } from "../server/diagnostics/metrics.ts";

const NOW = 1_000_000;
const D = "/h/.claude";
const INJECT = 'printf %s "$input" | "$CONFIG_DIR/corral-status-capture.sh" "$CONFIG_DIR" &';
const deps = (over: Partial<CheckDeps>): CheckDeps => ({
  env: { HOME: "/h" }, pathEnv: "/usr/bin", nodeVersion: "22.3.1",
  isFile: () => true, isExec: () => true, isDir: () => true,
  readText: () => null, hashFile: () => "h",
  repoRoot: "/repo", now: () => NOW,
  ...over,
});
const byId = (cs: readonly Check[], id: string): Check | undefined => cs.find((c) => c.id === id);
const files = (map: Readonly<Record<string, string>>) => (p: string): string | null => map[p] ?? null;

describe("capture-script", () => {
  it("warns when missing", () => {
    const c = byId(metricsChecks(deps({ isFile: () => false }), "work", D), "capture-script");
    expect(c?.state).toBe("problem");
    expect(c?.severity).toBe("warning");
    expect(c?.scope).toEqual({ kind: "configDir", envId: "work", dir: D });
  });

  it("warns when present but not executable, and says which of the two it is", () => {
    const c = byId(metricsChecks(deps({ isExec: () => false }), "work", D), "capture-script");
    expect(c?.state).toBe("problem");
    expect(c?.detail).toMatch(/not executable/i);
  });

  it("is ok when present and executable", () => {
    expect(byId(metricsChecks(deps({}), "work", D), "capture-script")?.state).toBe("ok");
  });
});

describe("statusline-registered", () => {
  it("passes for corral's script when the file carries the inject", () => {
    const d = deps({ readText: files({
      [`${D}/settings.json`]: JSON.stringify({ statusLine: { type: "command", command: `${D}/statusline-command.sh` } }),
      [`${D}/statusline-command.sh`]: `#!/bin/bash\n${INJECT}\n`,
    }) });
    expect(byId(metricsChecks(d, "work", D), "statusline-registered")?.state).toBe("ok");
  });

  it("FAILS for corral's script whose copy lost the inject — the name must not vouch for it", () => {
    const d = deps({ readText: files({
      [`${D}/settings.json`]: JSON.stringify({ statusLine: { type: "command", command: `${D}/statusline-command.sh` } }),
      [`${D}/statusline-command.sh`]: "#!/bin/bash\necho hi\n",
    }) });
    const c = byId(metricsChecks(d, "work", D), "statusline-registered");
    expect(c?.state).toBe("problem");
    expect(c?.detail).toMatch(/corral-status-capture\.sh/);
  });

  it("passes for the operator's own script that carries the inject", () => {
    const d = deps({ readText: files({
      [`${D}/settings.json`]: JSON.stringify({ statusLine: { type: "command", command: "bash /opt/mine.sh" } }),
      "/opt/mine.sh": INJECT,
    }) });
    expect(byId(metricsChecks(d, "work", D), "statusline-registered")?.state).toBe("ok");
  });

  it("resolves an interpreter prefix and a ~ path", () => {
    const d = deps({ readText: files({
      [`${D}/settings.json`]: JSON.stringify({ statusLine: { type: "command", command: "bash ~/.claude/statusline-command.sh" } }),
      "/h/.claude/statusline-command.sh": INJECT,
    }) });
    expect(byId(metricsChecks(d, "work", D), "statusline-registered")?.state).toBe("ok");
  });

  it("warns when statusLine is absent, when type is not command, and when settings.json is malformed", () => {
    const absent = deps({ readText: files({ [`${D}/settings.json`]: JSON.stringify({ theme: "custom:corral" }) }) });
    const wrongType = deps({ readText: files({ [`${D}/settings.json`]: JSON.stringify({ statusLine: { type: "static", command: "x" } }) }) });
    const broken = deps({ readText: () => "{not json" });
    for (const d of [absent, wrongType, broken]) {
      expect(byId(metricsChecks(d, "work", D), "statusline-registered")?.state).toBe("problem");
    }
  });

  it("warns when the referenced script cannot be read at all", () => {
    const d = deps({ readText: files({
      [`${D}/settings.json`]: JSON.stringify({ statusLine: { type: "command", command: "/opt/gone.sh" } }),
    }) });
    const c = byId(metricsChecks(d, "work", D), "statusline-registered");
    expect(c?.state).toBe("problem");
    expect(c?.detail).toContain("/opt/gone.sh");
  });
});
