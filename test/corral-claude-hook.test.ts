import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/corral-claude-hook.sh");

const dirs: string[] = [];
afterEach(() => { while (dirs.length) { const d = dirs.pop(); if (d) rmSync(d, { recursive: true, force: true }); } });

const servers: http.Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    if (s) await new Promise<void>((resolve) => { s.close(() => { resolve(); }); });
  }
});

function hasJq(): boolean {
  try { execFileSync("jq", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

// A minimal HTTP server standing in for the corral API's /api/card-signal route. Resolves the port
// once actually listening, so the test can point CORRAL_URL at it; registered for close() in afterEach.
function startServer(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => { resolve((server.address() as AddressInfo).port); });
  });
}

// A PATH containing only symlinks to bash/jq/awk/cat (no curl), for the "missing curl"
// precondition — resolved via `which` so the fixture works on whatever machine runs the suite.
// Cleaned up alongside the other fixture dirs in afterEach.
function noCurlPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-no-curl-"));
  dirs.push(dir);
  for (const bin of ["bash", "jq", "awk", "cat"]) {
    const real = execFileSync("which", [bin]).toString().trim();
    symlinkSync(real, path.join(dir, bin));
  }
  return dir;
}

// Default CORRAL_HOME for tests that don't care about thresholds config — keeps the hook from
// reading the real machine's ~/.corral/config.json (see finding #2, test hermeticity). Fresh per
// test, cleaned up alongside the other fixture dirs in afterEach.
let defaultCorralHome = "";
beforeEach(() => {
  defaultCorralHome = mkdtempSync(path.join(os.tmpdir(), "corral-home-default-"));
  dirs.push(defaultCorralHome);
});

// The harness runs on a developer's own machine, so without these the script would pick up their
// real CORRAL_URL/HERDR_* and an "unreachable server" case could hit the corral actually running
// there. A test that cares sets its own value in `env`, which always wins (spread order below).
const HERMETIC_DEFAULTS: NodeJS.ProcessEnv = {
  CORRAL_URL: "", HERDR_DASH_PORT: "", HERDR_PANE_ID: "", HERDR_SOCKET_PATH: "",
};

// Async (execFile, not execFileSync): several card-signal cases point the hook at a mock HTTP server
// running in this SAME process. A synchronous child-process call blocks this process's event loop, so
// that server could never accept the hook's request — the hook would just hang until curl's own
// --max-time gave up. Awaiting a child process keeps the loop free to service it. execFile's callback
// form has no `input` option (unlike execFileSync) — write it to the child's stdin instead.
function run(input: string, env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; status: number }> {
  const withDefaultHome = "CORRAL_HOME" in env ? env : { ...env, CORRAL_HOME: defaultCorralHome };
  const merged = { ...HERMETIC_DEFAULTS, ...withDefaultHome };
  return new Promise((resolve) => {
    const child = execFile("bash", [SCRIPT], { env: { ...process.env, ...merged } }, (err, stdout) => {
      if (err === null) { resolve({ stdout, status: 0 }); return; }
      const status = "code" in err && typeof err.code === "number" ? err.code : 1;
      resolve({ stdout, status });
    });
    child.stdin?.end(input);
  });
}

describe.skipIf(!hasJq())("corral-claude-hook.sh", () => {
  it("exits 0 with no output when hook_event_name is missing", async () => {
    const { stdout, status } = await run(JSON.stringify({ session_id: "abc" }));
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output for an unrecognized hook_event_name", async () => {
    const { stdout, status } = await run(JSON.stringify({ hook_event_name: "Stop" }));
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when stdin is not valid JSON", async () => {
    const { stdout, status } = await run("not json");
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

const CARD_BLOCK = [
  "<!-- card-signal:start -->",
  "## Card-empty signal",
  "",
  "some card protocol text",
  "<!-- card-signal:end -->",
].join("\n");

describe.skipIf(!hasJq())("corral-claude-hook.sh — SessionStart", () => {
  it("emits the ctx-signal block from SKILL.md", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    skillFixture(configDir, `# corral\n\n${CTX_BLOCK}\n\n## Other section\n`);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "SessionStart" }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("## Context pressure signal");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("some protocol text");
  });

  it("exits 0 with no output when SKILL.md is not installed", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "SessionStart" }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when SKILL.md has no ctx-signal markers", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    skillFixture(configDir, "# corral\n\nno markers here\n");
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "SessionStart" }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("emits the card-signal block from SKILL.md", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    skillFixture(configDir, `# corral\n\n${CARD_BLOCK}\n`);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "SessionStart" }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(parsed.hookSpecificOutput.additionalContext).toContain("## Card-empty signal");
  });

  it("emits both blocks together when both are present", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    skillFixture(configDir, `# corral\n\n${CTX_BLOCK}\n\n${CARD_BLOCK}\n`);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "SessionStart" }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(parsed.hookSpecificOutput.additionalContext).toContain("## Context pressure signal");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("## Card-empty signal");
  });
});

const SID = "a13ad559-8e59-4b98-b420-2746ef0b94d8";

function withSkill(configDir: string, blocks: readonly string[] = [CTX_BLOCK]): void {
  skillFixture(configDir, `# corral\n\n${blocks.join("\n\n")}\n`);
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
  it("exits 0 with no output when SKILL.md has no ctx-signal markers", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    skillFixture(configDir, "# corral\n\nno markers here\n");
    statusFixture(configDir, SID, 70);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when session_id is missing", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when session_id has path-traversal-shaped characters", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    statusFixture(configDir, SID, 70);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "../../etc/passwd" }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when the status file is missing", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when ctx.pct is null", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    statusFixture(configDir, SID, null);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("stays silent below the lowest default threshold", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    statusFixture(configDir, SID, 29);
    const { stdout, status } = await run(
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
  ])("classifies pct %i as %s under default thresholds", async (pct, band) => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    statusFixture(configDir, SID, pct);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(status).toBe(0);
    expect(additionalContext(stdout)).toBe(`[corral] ctx ${String(pct)}% (${band})`);
  });

  it("honors ctxThresholds from CORRAL_HOME/config.json", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    statusFixture(configDir, SID, 12);
    const home = corralHomeFixture({ hooks: { ctxThresholds: [10, 20, 30] } });
    const { stdout, status } = await run(
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
  ])("falls back to default thresholds on %s", async (_label, contents) => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir);
    statusFixture(configDir, SID, 45);
    const home = corralHomeFixture(contents);
    const { stdout, status } = await run(
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

function jsonHandler(body: unknown, status = 200): http.RequestListener {
  return (_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

describe.skipIf(!hasJq())("corral-claude-hook.sh — UserPromptSubmit — card-signal", () => {
  it("emits the card-empty line when the server answers empty:true", async () => {
    const port = await startServer(jsonHandler({ empty: true }));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CARD_BLOCK]);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(additionalContext(stdout)).toBe("[corral] card empty");
  });

  it("a 200 body of {\"empty\": false} emits nothing", async () => {
    const port = await startServer(jsonHandler({ empty: false }));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CARD_BLOCK]);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when SKILL.md has no card-signal markers", async () => {
    const port = await startServer(jsonHandler({ empty: true }));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    skillFixture(configDir, "# corral\n\nno markers here\n");
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("respects hooks.cardSignal: false", async () => {
    const port = await startServer(jsonHandler({ empty: true }));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CARD_BLOCK]);
    const home = corralHomeFixture({ hooks: { cardSignal: false } });
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      { CLAUDE_CONFIG_DIR: configDir, CORRAL_HOME: home, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when HERDR_PANE_ID is absent", async () => {
    const port = await startServer(jsonHandler({ empty: true }));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CARD_BLOCK]);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      { CLAUDE_CONFIG_DIR: configDir, CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when curl is missing", async () => {
    const port = await startServer(jsonHandler({ empty: true }));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CARD_BLOCK]);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      {
        CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1",
        CORRAL_URL: `http://127.0.0.1:${String(port)}`, PATH: noCurlPath(),
      },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output on connection refused", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CARD_BLOCK]);
    // Nothing listens on this port — bind-and-release just to grab one that is free right now.
    const probe = http.createServer();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, "127.0.0.1", () => { resolve((probe.address() as AddressInfo).port); });
    });
    await new Promise<void>((resolve) => { probe.close(() => { resolve(); }); });
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output on a non-2xx response", async () => {
    const port = await startServer(jsonHandler({ empty: true }, 500));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CARD_BLOCK]);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 0 with no output when the server hangs past --max-time", async () => {
    const port = await startServer((_req, res) => {
      setTimeout(() => { res.writeHead(200); res.end("{}"); }, 5000);
    });
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CARD_BLOCK]);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
  }, 10000);

  it.each([
    ["empty HERDR_DASH_PORT", ""],
    ["malformed HERDR_DASH_PORT", "abc"],
  ])("does not crash the URL on %s — falls back rather than addressing port 0 or ':'", async (_label, portValue) => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CARD_BLOCK]);
    // Deliberately no CORRAL_URL: a malformed/empty port must fall back to 8787 rather than build
    // "http://127.0.0.1:" (an immediate curl failure) or "http://127.0.0.1:0". Either bad shape would
    // still exit 0 under this hook's best-effort contract, so the real assertion is that this doesn't
    // throw or hang — connection failure to whatever is (or isn't) on 8787 is a silent no-op either way.
    const { status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", HERDR_DASH_PORT: portValue },
    );
    expect(status).toBe(0);
  });

  it("honors CORRAL_URL over the default port", async () => {
    const port = await startServer(jsonHandler({ empty: true }));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CARD_BLOCK]);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      {
        CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1",
        CORRAL_URL: `http://127.0.0.1:${String(port)}`, HERDR_DASH_PORT: "1",
      },
    );
    expect(status).toBe(0);
    expect(additionalContext(stdout)).toBe("[corral] card empty");
  });

  it("percent-encodes a cwd containing a space and an ampersand", async () => {
    let receivedUrl = "";
    const port = await startServer((req, res) => {
      receivedUrl = req.url ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ empty: true }));
    });
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CARD_BLOCK]);
    const { status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: "/a path/with & in it" }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(receivedUrl).toContain("cwd=%2Fa%20path%2Fwith%20%26%20in%20it");
  });

  it("does not suppress the card line when ctx data is absent", async () => {
    const port = await startServer(jsonHandler({ empty: true }));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CTX_BLOCK, CARD_BLOCK]);
    // No statusFixture written: ctx has no status file to read.
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(additionalContext(stdout)).toBe("[corral] card empty");
  });

  it("does not suppress the card line when ctx is below the lowest threshold", async () => {
    const port = await startServer(jsonHandler({ empty: true }));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CTX_BLOCK, CARD_BLOCK]);
    statusFixture(configDir, SID, 5);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(additionalContext(stdout)).toBe("[corral] card empty");
  });

  it("does not suppress the card line when session_id is absent", async () => {
    const port = await startServer(jsonHandler({ empty: true }));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CTX_BLOCK, CARD_BLOCK]);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(additionalContext(stdout)).toBe("[corral] card empty");
  });

  it("does not suppress the card line when session_id is malformed", async () => {
    const port = await startServer(jsonHandler({ empty: true }));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CTX_BLOCK, CARD_BLOCK]);
    statusFixture(configDir, "not-a-real-sid", 45);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "../../etc/passwd" }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(additionalContext(stdout)).toBe("[corral] card empty");
  });

  it("emits both lines together, ctx first, when both fire", async () => {
    const port = await startServer(jsonHandler({ empty: true }));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CTX_BLOCK, CARD_BLOCK]);
    statusFixture(configDir, SID, 45);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(additionalContext(stdout)).toBe("[corral] ctx 45% (nudge)\n[corral] card empty");
  });

  it("each missing block suppresses only its own line — card present, ctx absent", async () => {
    const port = await startServer(jsonHandler({ empty: true }));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CARD_BLOCK]);
    statusFixture(configDir, SID, 45);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(additionalContext(stdout)).toBe("[corral] card empty");
  });

  it("each missing block suppresses only its own line — ctx present, card absent", async () => {
    const port = await startServer(jsonHandler({ empty: true }));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "corral-hook-"));
    dirs.push(configDir);
    withSkill(configDir, [CTX_BLOCK]);
    statusFixture(configDir, SID, 45);
    const { stdout, status } = await run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID }),
      { CLAUDE_CONFIG_DIR: configDir, HERDR_PANE_ID: "w1:p1", CORRAL_URL: `http://127.0.0.1:${String(port)}` },
    );
    expect(status).toBe(0);
    expect(additionalContext(stdout)).toBe("[corral] ctx 45% (nudge)");
  });
});

describe("skills/corral/SKILL.md — card-signal markers", () => {
  it("carries both the ctx-signal and card-signal marker pairs", () => {
    const skillPath = path.resolve(import.meta.dirname, "../skills/corral/SKILL.md");
    const text = execFileSync("cat", [skillPath]).toString();
    expect(text).toContain("<!-- ctx-signal:start -->");
    expect(text).toContain("<!-- ctx-signal:end -->");
    expect(text).toContain("<!-- card-signal:start -->");
    expect(text).toContain("<!-- card-signal:end -->");
  });
});
