import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/corral-claude-hook.sh");

const dirs: string[] = [];
afterEach(() => { while (dirs.length) { const d = dirs.pop(); if (d) rmSync(d, { recursive: true, force: true }); } });

function hasJq(): boolean {
  try { execFileSync("jq", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

function run(input: string, env: NodeJS.ProcessEnv = {}): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("bash", [SCRIPT], { input, env: { ...process.env, ...env } });
    return { stdout: stdout.toString(), status: 0 };
  } catch (err) {
    const e = err as { status: number | null; stdout: Buffer };
    return { stdout: e.stdout.toString(), status: e.status ?? 1 };
  }
}

describe.skipIf(!hasJq())("corral-claude-hook.sh", () => {
  it("exits 0 with no output when hook_event_name is missing", () => {
    const { stdout, status } = run(JSON.stringify({ session_id: "abc" }));
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output for an unrecognized hook_event_name", () => {
    const { stdout, status } = run(JSON.stringify({ hook_event_name: "Stop" }));
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when stdin is not valid JSON", () => {
    const { stdout, status } = run("not json");
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });
});

function skillFixture(configDir: string, body: string): void {
  const dir = path.join(configDir, "skills", "corral");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), body);
}

const CTX_BLOCK = [
  "<!-- ctx-signal:start -->",
  "## Context pressure signal",
  "",
  "some protocol text",
  "<!-- ctx-signal:end -->",
].join("\n");

describe.skipIf(!hasJq())("corral-claude-hook.sh — SessionStart", () => {
  it("emits the ctx-signal block from SKILL.md", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    skillFixture(configDir, `# corral\n\n${CTX_BLOCK}\n\n## Other section\n`);
    const { stdout, status } = run(
      JSON.stringify({ hook_event_name: "SessionStart" }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("## Context pressure signal");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("some protocol text");
  });

  it("exits 0 with no output when SKILL.md is not installed", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    const { stdout, status } = run(
      JSON.stringify({ hook_event_name: "SessionStart" }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when SKILL.md has no ctx-signal markers", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    skillFixture(configDir, "# corral\n\nno markers here\n");
    const { stdout, status } = run(
      JSON.stringify({ hook_event_name: "SessionStart" }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });
});
