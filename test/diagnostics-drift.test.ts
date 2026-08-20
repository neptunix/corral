import { describe, it, expect } from "vitest";

import type { CheckDeps } from "../server/diagnostics/deps.ts";
import { driftCheck, themeCheck } from "../server/diagnostics/drift.ts";

const NOW = 3_000;
const D = "/h/.claude";
const R = "/repo";
const deps = (over: Partial<CheckDeps>): CheckDeps => ({
  env: { HOME: "/h" }, pathEnv: "/usr/bin", nodeVersion: "22.3.1",
  isFile: () => true, isExec: () => true, isDir: () => true,
  readText: () => null, hashFile: () => "same",
  repoRoot: R, now: () => NOW,
  ...over,
});

describe("helper-drift", () => {
  it("is ok when every tracked file matches the checkout", () => {
    expect(driftCheck(deps({}), "work", D).state).toBe("ok");
  });

  it("warns and names each drifted file", () => {
    const d = deps({ hashFile: (p) => (p === `${D}/corral-status-capture.sh` ? "old" : "same") });
    const c = driftCheck(d, "work", D);
    expect(c.state).toBe("problem");
    expect(c.severity).toBe("warning");
    expect(c.detail).toContain("corral-status-capture.sh");
  });

  it("titles the failing state without claiming a direction — the hash only proves the two sides differ", () => {
    const d = deps({ hashFile: (p) => (p === `${D}/corral-status-capture.sh` ? "old" : "same") });
    const c = driftCheck(d, "work", D);
    expect(c.title).toBe(`installed helper files differ from the checkout in ${D}`);
    expect(c.title).not.toContain("stale");
    expect(c.detail).toContain("corral-status-capture.sh");
  });

  it("never reports statusline-command.sh — README allows your own", () => {
    const d = deps({ hashFile: (p) => (p.endsWith("statusline-command.sh") ? "mine" : "same") });
    expect(driftCheck(d, "work", D).state).toBe("ok");
  });

  it("skips a file that is not installed — absence belongs to its own check", () => {
    const d = deps({ hashFile: (p) => (p === `${D}/corral-claude-hook.sh` ? null : "same") });
    expect(driftCheck(d, "work", D).state).toBe("ok");
  });

  it("is n/a when the checkout's own copy cannot be hashed — no baseline to compare against", () => {
    const d = deps({ hashFile: (p) => (p.startsWith(R) ? null : "installed") });
    expect(driftCheck(d, "work", D).state).toBe("n/a");
  });

  it("points at the section that tells you what to do about it", () => {
    const d = deps({ hashFile: (p) => (p.startsWith(D) ? "old" : "same") });
    expect(driftCheck(d, "work", D).doc?.anchor).toBe("upgrading");
  });
});

describe("theme-installed", () => {
  it("is info when the preset file is missing", () => {
    const c = themeCheck(deps({ isFile: (p) => p !== `${D}/themes/corral.json` }), "work", D);
    expect(c.state).toBe("problem");
    expect(c.severity).toBe("info");
  });

  it("is info when the file exists but the theme is not selected", () => {
    const c = themeCheck(deps({ readText: () => JSON.stringify({ theme: "dark" }) }), "work", D);
    expect(c.state).toBe("problem");
    expect(c.severity).toBe("info");
  });

  it("is ok when the preset exists and custom:corral is selected", () => {
    const c = themeCheck(deps({ readText: () => JSON.stringify({ theme: "custom:corral" }) }), "work", D);
    expect(c.state).toBe("ok");
  });
});
