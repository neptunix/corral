import type { Check } from "@shared/diagnostics-schema";
import { describe, it, expect } from "vitest";

import { ctxHookChecks, ctxThresholdsCheck } from "../server/diagnostics/ctx-hook.ts";
import type { CheckDeps } from "../server/diagnostics/deps.ts";

const NOW = 7_000;
const D = "/h/.claude";
const HOME = "/h/.corral";
const HOOK = `${D}/corral-claude-hook.sh`;
const SKILL = `${D}/skills/corral/SKILL.md`;
const GOOD_SKILL = "text\n<!-- ctx-signal:start -->\nprotocol\n<!-- ctx-signal:end -->\n";
const BOTH = {
  hooks: {
    SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: HOOK }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: HOOK }] }],
  },
};
const files = (map: Readonly<Record<string, string>>) => (p: string): string | null => map[p] ?? null;
const base = { [SKILL]: GOOD_SKILL, [`${D}/settings.json`]: JSON.stringify(BOTH) };
const deps = (over: Partial<CheckDeps>): CheckDeps => ({
  env: { HOME: "/h" }, pathEnv: "/usr/bin", nodeVersion: "22.3.1",
  isFile: () => true, isExec: () => true, isDir: () => true,
  readText: files(base), hashFile: () => "h",
  repoRoot: "/repo", now: () => NOW,
  ...over,
});
const byId = (cs: readonly Check[], id: string): Check | undefined => cs.find((c) => c.id === id);

describe("ctx-hook-installed", () => {
  it("warns when the script is absent — sessions never learn their own ctx%", () => {
    const c = byId(ctxHookChecks(deps({ isFile: (p) => p !== HOOK }), "work", D), "ctx-hook-installed");
    expect(c?.state).toBe("problem");
    expect(c?.severity).toBe("warning");
  });
  it("warns when present but not executable", () => {
    const c = byId(ctxHookChecks(deps({ isExec: (p) => p !== HOOK }), "work", D), "ctx-hook-installed");
    expect(c?.state).toBe("problem");
  });
  it("is ok when installed and executable", () => {
    expect(byId(ctxHookChecks(deps({}), "work", D), "ctx-hook-installed")?.state).toBe("ok");
  });
});

describe("ctx-hook-registered", () => {
  it("is ok when both events point at the script", () => {
    expect(byId(ctxHookChecks(deps({}), "work", D), "ctx-hook-registered")?.state).toBe("ok");
  });

  it("names the missing event when only UserPromptSubmit is registered", () => {
    const d = deps({ readText: files({ ...base,
      [`${D}/settings.json`]: JSON.stringify({ hooks: { UserPromptSubmit: BOTH.hooks.UserPromptSubmit } }) }) });
    const c = byId(ctxHookChecks(d, "work", D), "ctx-hook-registered");
    expect(c?.state).toBe("problem");
    expect(c?.detail).toContain("SessionStart");
  });

  it("names the missing event when only SessionStart is registered", () => {
    const d = deps({ readText: files({ ...base,
      [`${D}/settings.json`]: JSON.stringify({ hooks: { SessionStart: BOTH.hooks.SessionStart } }) }) });
    expect(byId(ctxHookChecks(d, "work", D), "ctx-hook-registered")?.detail).toContain("UserPromptSubmit");
  });

  it("warns when the SessionStart matcher omits compact — the protocol is lost exactly when needed", () => {
    const d = deps({ readText: files({ ...base, [`${D}/settings.json`]: JSON.stringify({ hooks: {
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: HOOK }] }],
      UserPromptSubmit: BOTH.hooks.UserPromptSubmit,
    } }) }) });
    const c = byId(ctxHookChecks(d, "work", D), "ctx-hook-registered");
    expect(c?.state).toBe("problem");
    expect(c?.detail).toContain("compact");
  });

  it("ignores entries pointing at some other command", () => {
    const d = deps({ readText: files({ ...base, [`${D}/settings.json`]: JSON.stringify({ hooks: {
      SessionStart: [{ matcher: "startup|compact", hooks: [{ type: "command", command: "/other/hook.sh" }] }],
      UserPromptSubmit: BOTH.hooks.UserPromptSubmit,
    } }) }) });
    expect(byId(ctxHookChecks(d, "work", D), "ctx-hook-registered")?.state).toBe("problem");
  });

  it("is n/a when the script is not installed — there is nothing to register yet", () => {
    const c = byId(ctxHookChecks(deps({ isFile: (p) => p !== HOOK }), "work", D), "ctx-hook-registered");
    expect(c?.state).toBe("n/a");
  });
});

describe("corral-skill-installed", () => {
  it("warns when SKILL.md is absent while the hook is installed", () => {
    const d = deps({ readText: files({ [`${D}/settings.json`]: JSON.stringify(BOTH) }) });
    const c = byId(ctxHookChecks(d, "work", D), "corral-skill-installed");
    expect(c?.state).toBe("problem");
    expect(c?.severity).toBe("warning");
  });

  it("warns when SKILL.md predates the ctx-signal markers — presence is not enough", () => {
    const d = deps({ readText: files({ ...base, [SKILL]: "an older skill with no markers" }) });
    const c = byId(ctxHookChecks(d, "work", D), "corral-skill-installed");
    expect(c?.state).toBe("problem");
    expect(c?.detail).toMatch(/ctx-signal/);
  });

  it("warns when only one of the two markers is present", () => {
    const d = deps({ readText: files({ ...base, [SKILL]: "x\n<!-- ctx-signal:start -->\ny\n" }) });
    expect(byId(ctxHookChecks(d, "work", D), "corral-skill-installed")?.state).toBe("problem");
  });

  it("drops to info when the hook is not installed — then it is only an MCP recommendation", () => {
    const d = deps({ isFile: (p) => p !== HOOK, readText: files({ ...base, [SKILL]: "no markers" }) });
    expect(byId(ctxHookChecks(d, "work", D), "corral-skill-installed")?.severity).toBe("info");
  });

  it("is ok with both markers present", () => {
    expect(byId(ctxHookChecks(deps({}), "work", D), "corral-skill-installed")?.state).toBe("ok");
  });
});

describe("ctx-thresholds", () => {
  it("is global — one file, one row, whatever the config dirs are", () => {
    expect(ctxThresholdsCheck(deps({}), HOME).scope).toEqual({ kind: "global" });
  });

  it("is ok when config.json is absent — the documented fallback is 30/40/60", () => {
    const c = ctxThresholdsCheck(deps({ isFile: (p) => p !== `${HOME}/config.json` }), HOME);
    expect(c.state).toBe("ok");
  });

  it("is ok when the file exists without hooks.ctxThresholds — same as absent, to the hook", () => {
    const d = deps({ readText: files({ [`${HOME}/config.json`]: JSON.stringify({ other: true }) }) });
    expect(ctxThresholdsCheck(d, HOME).state).toBe("ok");
  });

  it("is info when the thresholds are not three ascending numbers", () => {
    for (const bad of [[60, 40, 30], [10, 20], [1, 2, 3, 4], ["a", "b", "c"], [10, 10, 20]]) {
      const d = deps({ readText: files({ [`${HOME}/config.json`]: JSON.stringify({ hooks: { ctxThresholds: bad } }) }) });
      const c = ctxThresholdsCheck(d, HOME);
      expect(c.state).toBe("problem");
      expect(c.severity).toBe("info");
    }
  });

  it("is ok for three ascending numbers", () => {
    const d = deps({ readText: files({ [`${HOME}/config.json`]: JSON.stringify({ hooks: { ctxThresholds: [25, 45, 70] } }) }) });
    expect(ctxThresholdsCheck(d, HOME).state).toBe("ok");
  });

  it("is info when the file is present but malformed — the hook silently uses defaults", () => {
    const d = deps({ readText: files({ [`${HOME}/config.json`]: "{not json" }) });
    expect(ctxThresholdsCheck(d, HOME).state).toBe("problem");
  });
});
