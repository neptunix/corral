import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/corral-claude-hook.sh");

const dirs: string[] = [];
afterEach(() => { while (dirs.length) { const d = dirs.pop(); if (d) rmSync(d, { recursive: true, force: true }); } });

function hasJq(): boolean {
  try { execFileSync("jq", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

// Default CORRAL_HOME for tests that don't care about thresholds config — keeps the hook from
// reading the real machine's ~/.corral/config.json (see finding #2, test hermeticity). Fresh per
// test, cleaned up alongside the other fixture dirs in afterEach.
let defaultCorralHome = "";
beforeEach(() => {
  defaultCorralHome = mkdtempSync(path.join(os.tmpdir(), "corral-home-default-"));
  dirs.push(defaultCorralHome);
});

function run(input: string, env: NodeJS.ProcessEnv = {}): { stdout: string; status: number } {
  const withDefaultHome = "CORRAL_HOME" in env ? env : { ...env, CORRAL_HOME: defaultCorralHome };
  try {
    const stdout = execFileSync("bash", [SCRIPT], { input, env: { ...process.env, ...withDefaultHome } });
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

const SID = "a13ad559-8e59-4b98-b420-2746ef0b94d8";

function withSkill(configDir: string): void {
  skillFixture(configDir, `# corral\n\n${CTX_BLOCK}\n`);
}

function statusFixture(configDir: string, sessionId: string, pct: number | null): void {
  const dir = path.join(configDir, "corral-status");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ ctx: { pct } }));
}

function corralHomeFixture(contents: unknown): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "corral-home-"));
  dirs.push(home);
  writeFileSync(
    path.join(home, "config.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
  return home;
}

function additionalContext(stdout: string): string {
  const parsed = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } };
  return parsed.hookSpecificOutput.additionalContext;
}

describe.skipIf(!hasJq())("corral-claude-hook.sh — UserPromptSubmit", () => {
  it("exits 0 with no output when session_id is missing", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    const { stdout, status } = run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when session_id has path-traversal-shaped characters", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    statusFixture(configDir, SID, 70);
    const { stdout, status } = run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "../../etc/passwd" }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when the status file is missing", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    const { stdout, status } = run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when ctx.pct is null", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    statusFixture(configDir, SID, null);
    const { stdout, status } = run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("stays silent below the lowest default threshold", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    statusFixture(configDir, SID, 29);
    const { stdout, status } = run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it.each([
    [30, "notice"],
    [39, "notice"],
    [40, "nudge"],
    [59, "nudge"],
    [60, "urgent"],
    [99, "urgent"],
  ])("classifies pct %i as %s under default thresholds", (pct, band) => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    statusFixture(configDir, SID, pct);
    const { stdout, status } = run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(additionalContext(stdout)).toBe(`[corral] ctx ${String(pct)}% (${band})`);
  });

  it("honors ctxThresholds from CORRAL_HOME/config.json", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    statusFixture(configDir, SID, 12);
    const home = corralHomeFixture({ hooks: { ctxThresholds: [10, 20, 30] } });
    const { stdout, status } = run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir, CORRAL_HOME: home },
    );
    expect(status).toBe(0);
    expect(additionalContext(stdout)).toBe("[corral] ctx 12% (notice)");
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["wrong-shaped array (2 elements)", JSON.stringify({ hooks: { ctxThresholds: [30, 40] } })],
    ["non-monotonic array", JSON.stringify({ hooks: { ctxThresholds: [60, 40, 30] } })],
    ["empty config.json", ""],
  ])("falls back to default thresholds on %s", (_label, contents) => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    statusFixture(configDir, SID, 45);
    const home = corralHomeFixture(contents);
    const { stdout, status } = run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir, CORRAL_HOME: home },
    );
    expect(status).toBe(0);
    expect(additionalContext(stdout)).toBe("[corral] ctx 45% (nudge)");
  });

  it("falls back to default thresholds when CORRAL_HOME is unset", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    statusFixture(configDir, SID, 45);
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "corral-fakehome-"));
    dirs.push(fakeHome);
    const { CORRAL_HOME: _corralHome, ...envWithoutCorralHome } = process.env;
    const env = { ...envWithoutCorralHome, CLAUDE_CONFIG_DIR: configDir, HOME: fakeHome };
    const stdout = execFileSync("bash", [SCRIPT], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      env,
    }).toString();
    expect(additionalContext(stdout)).toBe("[corral] ctx 45% (nudge)");
  });
});
