import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { syncClaudeThemeBase } from "../server/claude-theme";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "corral-theme-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeTheme(dir: string, contents: unknown): Promise<string> {
  const themesDir = path.join(dir, "themes");
  await fs.mkdir(themesDir, { recursive: true });
  const file = path.join(themesDir, "corral.json");
  await fs.writeFile(file, JSON.stringify(contents), "utf8");
  return file;
}

describe("syncClaudeThemeBase", () => {
  it("flips base and preserves other fields (name, overrides)", async () => {
    const file = await writeTheme(root, { name: "Corral", base: "dark", overrides: { claude: "#8257e5" } });

    const updated = await syncClaudeThemeBase([root], "light");

    expect(updated).toBe(1);
    const after: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    expect(after).toEqual({ name: "Corral", base: "light", overrides: { claude: "#8257e5" } });
  });

  it("counts and rewrites every dir that has a theme file", async () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await writeTheme(a, { base: "light" });
    await writeTheme(b, { base: "light" });

    const updated = await syncClaudeThemeBase([a, b], "dark");

    expect(updated).toBe(2);
    for (const dir of [a, b]) {
      const after: unknown = JSON.parse(await fs.readFile(path.join(dir, "themes", "corral.json"), "utf8"));
      expect(after).toEqual({ base: "dark" });
    }
  });

  it("skips a dir with no theme file (never creates one)", async () => {
    const updated = await syncClaudeThemeBase([root], "light");

    expect(updated).toBe(0);
    await expect(fs.access(path.join(root, "themes", "corral.json"))).rejects.toThrow();
  });

  it("skips a corrupt file without clobbering it", async () => {
    const themesDir = path.join(root, "themes");
    await fs.mkdir(themesDir, { recursive: true });
    const file = path.join(themesDir, "corral.json");
    await fs.writeFile(file, "{ not valid json", "utf8");

    const updated = await syncClaudeThemeBase([root], "dark");

    expect(updated).toBe(0);
    expect(await fs.readFile(file, "utf8")).toBe("{ not valid json");
  });

  it("skips a non-object JSON payload", async () => {
    const file = await writeTheme(root, ["array", "not", "object"]);

    const updated = await syncClaudeThemeBase([root], "dark");

    expect(updated).toBe(0);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(["array", "not", "object"]);
  });
});
