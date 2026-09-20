import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { syncClaudeThemeBase, syncRemoteClaudeThemeBase } from "../server/claude-theme";
import type { SpawnSsh } from "../server/remote-write.ts";

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

  it("skips writing (and doesn't count) when base already matches mode", async () => {
    const file = await writeTheme(root, { name: "Corral", base: "dark" });
    const before = await fs.stat(file);

    const updated = await syncClaudeThemeBase([root], "dark");

    expect(updated).toBe(0);
    const after = await fs.stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ name: "Corral", base: "dark" });
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

// Runs the real remote command under a local sh.
const runLocally: SpawnSsh = (_file, args) => spawn("sh", ["-c", args.at(-1) ?? ""]);
function remoteEnv(dirs: readonly string[]): Extract<HerdrEnv, { kind: "remote" }> {
  return { id: "e", label: "E", kind: "remote", sshHost: "host1", socket: "~/s.sock", herdrBin: "~/herdr", claudeConfigDirs: dirs, spawnCommand: "claude", repos: {} };
}

describe("syncRemoteClaudeThemeBase", () => {
  it("flips base through the remote scripts and preserves other fields", async () => {
    const file = await writeTheme(root, { name: "Corral", base: "dark", overrides: { claude: "#8257e5" } });

    const updated = await syncRemoteClaudeThemeBase(remoteEnv([root]), "light", runLocally);

    expect(updated).toBe(1);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ name: "Corral", base: "light", overrides: { claude: "#8257e5" } });
    expect((await fs.readdir(path.join(root, "themes")))).toEqual(["corral.json"]); // no temp file left
  });

  it("leaves a file that already matches untouched", async () => {
    const file = await writeTheme(root, { base: "dark" });
    const before = await fs.stat(file);
    expect(await syncRemoteClaudeThemeBase(remoteEnv([root]), "dark", runLocally)).toBe(0);
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it("skips a dir with no theme and never creates one", async () => {
    expect(await syncRemoteClaudeThemeBase(remoteEnv([root]), "light", runLocally)).toBe(0);
    await expect(fs.access(path.join(root, "themes"))).rejects.toThrow();
  });

  it("skips a corrupt file without clobbering it", async () => {
    const themesDir = path.join(root, "themes");
    await fs.mkdir(themesDir, { recursive: true });
    await fs.writeFile(path.join(themesDir, "corral.json"), "{ nope", "utf8");
    expect(await syncRemoteClaudeThemeBase(remoteEnv([root]), "dark", runLocally)).toBe(0);
    expect(await fs.readFile(path.join(themesDir, "corral.json"), "utf8")).toBe("{ nope");
  });

  it("handles a config dir containing a space and updates every dir", async () => {
    const a = path.join(root, "dir with space");
    const b = path.join(root, "b");
    await writeTheme(a, { base: "light" });
    await writeTheme(b, { base: "light" });
    expect(await syncRemoteClaudeThemeBase(remoteEnv([a, b]), "dark", runLocally)).toBe(2);
  });

  it("keeps going after one dir fails, then reports the error", async () => {
    const good = path.join(root, "good");
    await writeTheme(good, { base: "light" });
    const failing: SpawnSsh = (file, args) => {
      const cmd = args.at(-1) ?? "";
      return cmd.includes("bad") ? spawn("sh", ["-c", "exit 255"]) : runLocally(file, args);
    };
    await expect(syncRemoteClaudeThemeBase(remoteEnv([path.join(root, "bad"), good]), "dark", failing)).rejects.toThrow("ssh exit 255");
    expect(JSON.parse(await fs.readFile(path.join(good, "themes", "corral.json"), "utf8"))).toEqual({ base: "dark" });
  });

  it("replaces the target of a symlinked theme file, keeping the link", async () => {
    const target = path.join(root, "shared.json");
    await fs.writeFile(target, JSON.stringify({ base: "dark" }), "utf8");
    await fs.mkdir(path.join(root, "themes"));
    const link = path.join(root, "themes", "corral.json");
    await fs.symlink(target, link);

    expect(await syncRemoteClaudeThemeBase(remoteEnv([root]), "light", runLocally)).toBe(1);

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ base: "light" });
  });

  it("serializes overlapping syncs per env so the last request wins", async () => {
    const file = await writeTheme(root, { base: "dark" });
    // The first write is slow: without queuing, the second sync reads the stale value and skips its write.
    const slowWrite: SpawnSsh = (_f, args) => {
      const cmd = args.at(-1) ?? "";
      return spawn("sh", ["-c", cmd.includes("mv -f") ? `sleep 0.3; ${cmd}` : cmd]);
    };
    const first = syncRemoteClaudeThemeBase(remoteEnv([root]), "light", slowWrite);
    const second = syncRemoteClaudeThemeBase(remoteEnv([root]), "dark", runLocally);
    await Promise.all([first, second]);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ base: "dark" });
  });
});
