import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, it, expect } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/corral-claude-hook.sh");

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
