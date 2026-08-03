import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// The preflight guard lives as much in configuration as in code, and every defect below typechecks
// and lints clean — only reading the files catches a regression.
const root = path.join(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");

describe("the guard actually runs", () => {
  it("is wired as an npm pre-step for both documented launch paths", () => {
    const parsed: unknown = JSON.parse(read("package.json"));
    const scripts = ScriptsOf(parsed);
    expect(scripts.predev).toContain("scripts/preflight.ts");
    expect(scripts.prestart).toContain("scripts/preflight.ts");
  });
});

describe("the guard is inside npm run check", () => {
  it("typechecks scripts/", () => {
    // tsconfig.json carries comments, so it is read as text rather than JSON.
    expect(read("tsconfig.json")).toMatch(/"include"\s*:\s*\[[^\]]*"scripts"/);
  });

  it("lints scripts/*.ts — the eslint ignore may exclude .mjs there, not the whole directory", () => {
    const ignores = /ignores:\s*\[([^\]]*)\]/.exec(read("eslint.config.js"))?.[1] ?? "";
    expect(ignores).not.toMatch(/"scripts"/);
  });
});

describe("the config check cannot go inert again", () => {
  it("server/index.ts has no static value import of environments.ts", () => {
    // A re-added `import { ENVIRONMENTS }` compiles and lints clean while making the config try/catch
    // unreachable: ESM evaluates static imports before the importing module's body.
    const src = read("server/index.ts");
    expect(src).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+"\.\.\/environments\.ts"/m);
  });
});

function ScriptsOf(parsed: unknown): Record<string, string> {
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) return {};
  const { scripts } = parsed;
  if (typeof scripts !== "object" || scripts === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scripts)) if (typeof v === "string") out[k] = v;
  return out;
}
