import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";

// The guard lives as much in configuration as in code, and every defect below typechecks and lints
// clean — only reading the files, or running the thing, catches a regression.
const root = path.join(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");

const sandbox = mkdtempSync(path.join(os.tmpdir(), "corral-preflight-test-"));
afterAll(() => { rmSync(sandbox, { recursive: true, force: true }); });

/**
 * Runs a real entrypoint in a child process. The child is ISOLATED: server/index.ts runs its startup
 * block — upload/brief sweeps, git commits, poller, zombie reaper — before `serve()` fails, so an
 * inherited environment would point all of that at the operator's live corral.
 */
function run(entry: string, over: Record<string, string>): { status: number; stderr: string } {
  const env: Record<string, string> = {
    ...process.env,
    CORRAL_HOME: sandbox,
    BOARD_DATA_DIR: sandbox,
    HERDR_DASH_PORT: "0",
    ZOMBIE_REAP_ENABLED: "false",
    RECAP_ENABLED: "false",
    ...over,
  };
  delete env.CLAUDECODE; // must be ABSENT, not "" — see the empty-value case in preflight-report
  delete env.CORRAL_ALLOW_UNDER_CLAUDE;
  for (const [k, v] of Object.entries(over)) env[k] = v;
  try {
    execFileSync("npx", ["tsx", entry], {
      cwd: root, stdio: "pipe", encoding: "utf8",
      timeout: 20_000, // vitest cannot interrupt a blocking sync call; bound it at the OS level
      env,
    });
    return { status: 0, stderr: "" };
  } catch (err) {
    if (err !== null && typeof err === "object" && "status" in err && typeof err.status === "number") {
      const stderr = "stderr" in err && typeof err.stderr === "string" ? err.stderr : "";
      return { status: err.status, stderr };
    }
    throw err;
  }
}

/** An exit code alone proves nothing — any startup crash produces one. The guard must SAY it refused. */
function expectRefusal(r: { status: number; stderr: string }): void {
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("launched from inside a Claude Code session");
  expect(r.stderr).toContain("FATAL: refusing to start");
}

describe("the pre-step actually stops a launch", () => {
  // The guard's entire value is that it fires; unit tests of buildReport cannot show that the process
  // exits non-zero, which is the only thing npm reacts to.
  it("exits non-zero under Claude Code", () => {
    expectRefusal(run("scripts/preflight.ts", { CLAUDECODE: "1" }));
  }, 30_000);

  it("exits zero when the override is set", () => {
    expect(run("scripts/preflight.ts", { CLAUDECODE: "1", CORRAL_ALLOW_UNDER_CLAUDE: "1" }).status).toBe(0);
  }, 30_000);

  it("exits zero outside Claude Code", () => {
    expect(run("scripts/preflight.ts", {}).status).toBe(0);
  }, 30_000);
});

describe("the in-process guard is the backstop", () => {
  // Survives every npm-level bypass, so it needs its own execution proof: deleting the block from
  // server/index.ts must not leave the suite green.
  it("refuses to boot the server itself under Claude Code", () => {
    expectRefusal(run("server/index.ts", { CLAUDECODE: "1" }));
  }, 30_000);
});

describe("the guard is wired into npm", () => {
  it("runs inside dev and start themselves, not as a pre-hook", () => {
    // `npm run dev --ignore-scripts` skips pre/post hooks but still runs the script body, so putting
    // the guard in the body is the only shape --ignore-scripts cannot bypass. Verified empirically.
    const scripts = scriptsOf(JSON.parse(read("package.json")));
    for (const name of ["dev", "start"]) {
      expect(scripts[name]?.startsWith("tsx scripts/preflight.ts &&")).toBe(true);
    }
    expect(scripts.predev).toBeUndefined();
    expect(scripts.prestart).toBeUndefined();
  });
});

describe("the guard is inside npm run check", () => {
  it("typechecks scripts/", () => {
    // tsconfig.json carries comments, so it is read as text rather than JSON.
    const include = /"include"\s*:\s*\[([^\]]*)\]/.exec(read("tsconfig.json"))?.[1];
    expect(include).toBeDefined(); // fails loudly if the key is renamed, rather than passing vacuously
    expect(include).toContain('"scripts"');
  });

  it("lints scripts/*.ts — the ignore list may exclude .mjs there, not the whole directory", () => {
    const ignores = /ignores:\s*\[([^\]]*)\]/.exec(read("eslint.config.js"))?.[1];
    expect(ignores).toBeDefined();
    // Any pattern that swallows scripts/ wholesale re-hides the guard from the linter.
    const swallowsScripts = /"scripts"|"scripts\/\*+"|"scripts\/\*\*"|"scripts\/\*\*\/\*"/.test(ignores ?? "");
    expect(swallowsScripts).toBe(false);
  });
});

describe("the config check cannot go inert again", () => {
  it("no server module statically value-imports environments.ts", () => {
    // A static `import { ENVIRONMENTS }` anywhere in the graph evaluates environments.ts before the
    // startup body runs, making the config try/catch unreachable — and it compiles and lints clean.
    const offenders = serverSources().filter((f) =>
      /^import\s+\{[^}]*\}\s+from\s+"\.\.\/environments\.ts"/m.test(read(path.join("server", f))),
    );
    expect(offenders).toEqual([]);
  });
});

function serverSources(): string[] {
  // Walks subdirectories (server/diagnostics/ etc.) — a flat `ls` would leave nested modules outside
  // this guard's reach, silently exempting them from the environments.ts import check.
  return execFileSync("find", [".", "-name", "*.ts", "-type", "f"], { cwd: path.join(root, "server"), encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/^\.\//, ""));
}

function scriptsOf(parsed: unknown): Record<string, string> {
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) return {};
  const { scripts } = parsed;
  if (typeof scripts !== "object" || scripts === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scripts)) if (typeof v === "string") out[k] = v;
  return out;
}
