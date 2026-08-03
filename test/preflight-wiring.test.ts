import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// The guard lives as much in configuration as in code, and every defect below typechecks and lints
// clean — only reading the files, or running the thing, catches a regression.
const root = path.join(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");

/** Runs a real entrypoint in a child process and returns its exit code. */
function run(entry: string, env: Record<string, string>): number {
  try {
    execFileSync("npx", ["tsx", entry], {
      cwd: root,
      stdio: "pipe",
      timeout: 20_000, // vitest cannot interrupt a blocking sync call; bound it at the OS level
      env: { ...process.env, CLAUDECODE: "", CORRAL_ALLOW_UNDER_CLAUDE: "", ...env },
    });
    return 0;
  } catch (err) {
    if (err !== null && typeof err === "object" && "status" in err && typeof err.status === "number") {
      return err.status;
    }
    throw err;
  }
}

describe("the pre-step actually stops a launch", () => {
  // The guard's entire value is that it fires; unit tests of buildReport cannot show that the process
  // exits non-zero, which is the only thing npm reacts to.
  it("exits non-zero under Claude Code", () => {
    expect(run("scripts/preflight.ts", { CLAUDECODE: "1" })).toBe(1);
  }, 30_000);

  it("exits zero when the override is set", () => {
    expect(run("scripts/preflight.ts", { CLAUDECODE: "1", CORRAL_ALLOW_UNDER_CLAUDE: "1" })).toBe(0);
  }, 30_000);

  it("exits zero outside Claude Code", () => {
    expect(run("scripts/preflight.ts", {})).toBe(0);
  }, 30_000);
});

describe("the in-process guard is the backstop", () => {
  // Survives every npm-level bypass, so it needs its own execution proof: deleting the block from
  // server/index.ts must not leave the suite green.
  it("refuses to boot the server itself under Claude Code", () => {
    expect(run("server/index.ts", { CLAUDECODE: "1" })).toBe(1);
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
  return execFileSync("ls", ["server"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts"));
}

function scriptsOf(parsed: unknown): Record<string, string> {
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) return {};
  const { scripts } = parsed;
  if (typeof scripts !== "object" || scripts === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scripts)) if (typeof v === "string") out[k] = v;
  return out;
}
