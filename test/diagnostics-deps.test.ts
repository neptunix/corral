import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { createNodeDeps, locateTool, resolveCommandPath, STANDARD_BIN_DIRS } from "../server/diagnostics/deps.ts";

const deps = (over: Partial<ReturnType<typeof createNodeDeps>>) =>
  ({ ...createNodeDeps({ repoRoot: "/repo" }), ...over });

describe("resolveCommandPath", () => {
  it("skips an interpreter prefix", () => {
    expect(resolveCommandPath("bash ~/.claude/statusline-command.sh", "/h"))
      .toBe("/h/.claude/statusline-command.sh");
  });
  it("keeps the script when it carries arguments — the common healthy case must not read as broken", () => {
    expect(resolveCommandPath("/opt/mine.sh --json", "/h")).toBe("/opt/mine.sh");
    expect(resolveCommandPath("bash /opt/mine.sh --json", "/h")).toBe("/opt/mine.sh");
  });
  it("leaves an absolute path alone", () => {
    expect(resolveCommandPath("/opt/mine.sh", "/h")).toBe("/opt/mine.sh");
  });
  it("leaves ~ unexpanded when HOME is unknown, rather than inventing a path", () => {
    expect(resolveCommandPath("~/x.sh", undefined)).toBe("~/x.sh");
  });
  it("returns empty string for an empty command", () => {
    expect(resolveCommandPath("   ", "/h")).toBe("");
  });
});

describe("locateTool", () => {
  it("finds a tool on the server's PATH and says so", () => {
    const d = deps({ pathEnv: "/a:/b", isFile: (p) => p === "/b/jq", isExec: (p) => p === "/b/jq" });
    expect(locateTool("jq", d)).toEqual({ path: "/b/jq", onServerPath: true });
  });

  it("still finds a tool that is only in a standard dir, and flags that it is off-PATH", () => {
    const std = STANDARD_BIN_DIRS[0] ?? "/usr/bin";
    const d = deps({ pathEnv: "/a", isFile: (p) => p === `${std}/jq`, isExec: (p) => p === `${std}/jq` });
    expect(locateTool("jq", d)).toEqual({ path: `${std}/jq`, onServerPath: false });
  });

  it("reports absent when neither PATH nor the standard dirs have it", () => {
    const d = deps({ pathEnv: "/a", isFile: () => false, isExec: () => false });
    expect(locateTool("jq", d)).toEqual({ path: null, onServerPath: false });
  });

  it("includes the usual install locations", () => {
    expect(STANDARD_BIN_DIRS).toContain("/usr/bin");
    expect(STANDARD_BIN_DIRS).toContain("/usr/local/bin");
    expect(STANDARD_BIN_DIRS).toContain("/opt/homebrew/bin");
  });
});

describe("createNodeDeps — readText guards", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "corral-deps-"));
  const d = createNodeDeps({ repoRoot: "/repo" });

  it("reads a regular file", () => {
    const p = path.join(tmp, "ok.json");
    writeFileSync(p, "hello");
    expect(d.readText(p)).toBe("hello");
  });

  it("returns null for a missing file instead of throwing", () => {
    expect(d.readText(path.join(tmp, "nope"))).toBe(null);
  });

  it("returns null for a directory", () => {
    expect(d.readText(tmp)).toBe(null);
  });

  it("returns null past the size cap rather than loading it every sweep", () => {
    const p = path.join(tmp, "big.json");
    writeFileSync(p, "x".repeat(2_000_000));
    expect(d.readText(p)).toBe(null);
  });

  it("refuses a non-regular file — reading a FIFO would block the event loop forever", () => {
    // node:fs has no mkfifo; shell out. If the platform lacks it, there is nothing to assert.
    const p = path.join(tmp, "fifo");
    try { execFileSync("mkfifo", [p]); } catch { return; }
    expect(d.readText(p)).toBe(null);
  });

  it("reports the running Node version without any env override", () => {
    expect(d.nodeVersion).toBe(process.versions.node);
  });
});
