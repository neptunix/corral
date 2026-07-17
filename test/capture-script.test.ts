import { StatuslineDataSchema } from "@shared/schema";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";

// `__dirname` is not defined under this repo's ESM ("type": "module") + Bundler moduleResolution
// setup — `import.meta.dirname` is the direct replacement, already used the same way in
// test/setup.ts.
const SCRIPT = path.resolve(import.meta.dirname, "../scripts/corral-status-capture.sh");
const dirs: string[] = [];
afterEach(() => { while (dirs.length) { const d = dirs.pop(); if (d) rmSync(d, { recursive: true, force: true }); } });

function hasJq(): boolean {
  try { execFileSync("jq", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

// HOME is pinned to the isolated configDir so the script's account fallback
// ($CONFIG_DIR/.claude.json → $HOME/.claude.json) can't leak the test runner's real ~/.claude.json
// into a fixture. Tests that exercise the fallback pass their own HOME explicitly.
function run(configDir: string, input: unknown, home: string = configDir): void {
  execFileSync("bash", [SCRIPT, configDir], { input: JSON.stringify(input), env: { ...process.env, HOME: home } });
}

describe.skipIf(!hasJq())("corral-status-capture.sh", () => {
  const statusInput = {
    session_id: "a13ad559-8e59-4b98-b420-2746ef0b94d8", session_name: "task-42-a",
    model: { id: "claude-opus-4-8", display_name: "Opus" },
    context_window: { used_percentage: 42, total_input_tokens: 84000, context_window_size: 200000 },
    cost: { total_cost_usd: 0.83, total_lines_added: 120, total_lines_removed: 30 },
    rate_limits: { five_hour: { used_percentage: 31, resets_at: 1752360000 },
                   seven_day: { used_percentage: 58, resets_at: 1752900000 } },
    effort: { level: "high" }, thinking: { enabled: true }, version: "2.1.205",
  };

  it("maps statusline JSON to a valid v1 file with account", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-cap-")); dirs.push(configDir);
    writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({
      oauthAccount: { accountUuid: "u1", emailAddress: "a@b.c", organizationName: "O", organizationRateLimitTier: "default_claude_max_20x" },
    }));
    run(configDir, statusInput);
    const out = JSON.parse(readFileSync(path.join(configDir, "corral-status", `${statusInput.session_id}.json`), "utf8"));
    const parsed = StatuslineDataSchema.parse(out);
    expect(parsed.model).toBe("Opus");
    expect(parsed.ctx).toEqual({ pct: 42, tokens: 84000, window: 200000 });
    expect(parsed.account).toEqual({ uuid: "u1", email: "a@b.c", org: "O", tier: "default_claude_max_20x" });
    expect(parsed.rate.five_hour?.used_percentage).toBe(31);
  });

  it("falls back to $HOME/.claude.json for the account when the nested one is absent (remote-box layout)", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "corral-home-")); dirs.push(home);
    const configDir = path.join(home, ".claude");
    mkdirSync(configDir, { recursive: true });
    // account ONLY at $HOME/.claude.json (top-level), not $CONFIG_DIR/.claude.json — matches personal-box/work-box
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
      oauthAccount: { accountUuid: "u2", emailAddress: "remote@b.c", organizationName: "R", organizationRateLimitTier: "default_claude_max_5x" },
    }));
    run(configDir, statusInput, home);
    const out = JSON.parse(readFileSync(path.join(configDir, "corral-status", `${statusInput.session_id}.json`), "utf8"));
    expect(StatuslineDataSchema.parse(out).account?.uuid).toBe("u2");
  });

  it("tolerates missing account file and missing rate_limits", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-cap-")); dirs.push(configDir);
    // eslint-disable-next-line unused-imports/no-unused-vars -- destructured only to exclude it from noRate
    const { rate_limits, ...noRate } = statusInput;
    run(configDir, noRate);
    const out = JSON.parse(readFileSync(path.join(configDir, "corral-status", `${statusInput.session_id}.json`), "utf8"));
    const parsed = StatuslineDataSchema.parse(out);
    expect(parsed.account).toBeNull();
    expect(parsed.rate).toEqual({ five_hour: null, seven_day: null });
  });

  it("writes nothing when session_id is absent", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-cap-")); dirs.push(configDir);
    run(configDir, { model: { display_name: "Opus" } });
    expect(existsSync(path.join(configDir, "corral-status"))).toBe(false);
  });
});
