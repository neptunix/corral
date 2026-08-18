import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MAX_READABLE_BYTES, STANDARD_BIN_DIRS } from "../server/diagnostics/deps.ts";
import { buildManifest } from "../server/diagnostics/remote/manifest.ts";
import {
  buildRound2,
  buildRoundF,
  buildRoundT,
  PROBE_TOTAL_CAP_BYTES,
  ROUND_TIMEOUT_MS,
  screenRound2Path,
} from "../server/diagnostics/remote/script.ts";
import type { RemoteEnv } from "../server/diagnostics/remote/script.ts";
import { parseWire } from "../server/diagnostics/remote/wire.ts";

const env: RemoteEnv = {
  id: "box", label: "box", kind: "remote", sshHost: "h", socket: "~/s.sock",
  herdrBin: "~/.local/bin/herdr", claudeConfigDirs: ["/far/.claude"], spawnCommand: "claude", repos: {},
};

describe("buildRoundF", () => {
  it("composes ssh with the probe's own flag list and ONE remote command argument", () => {
    const spec = buildRoundF(env, buildManifest(env.claudeConfigDirs));
    expect(spec.file).toBe("ssh");
    expect(spec.args.slice(0, 4)).toEqual(["-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes"]);
    expect(spec.args[4]).toBe("h");
    expect(spec.args).toHaveLength(6);
    expect(spec.timeoutMs).toBe(ROUND_TIMEOUT_MS);
  });

  it("wraps bash -lc around ONLY the PATH snippet and emits PATH as its own key", () => {
    const spec = buildRoundF(env, buildManifest(env.claudeConfigDirs));
    const cmd = spec.args[5] ?? "";
    expect(cmd.match(/bash -lc/g)).toHaveLength(1);
    expect(cmd).toContain(`bash -lc 'printf %s "$PATH"'`);
  });

  it("pins the per-file cap to MAX_READABLE_BYTES and emits markers, never truncated content", () => {
    const cmd = buildRoundF(env, buildManifest(env.claudeConfigDirs)).args[5] ?? "";
    expect(cmd).toContain(`-gt ${String(MAX_READABLE_BYTES)}`);
    expect(cmd).toContain("!too-large:x");
    expect(cmd).not.toContain("head -c"); // truncation is banned outright
  });

  it("uses only POSIX primitives — no stat, no timeout(1), no base64 -w", () => {
    const cmd = buildRoundF(env, buildManifest(env.claudeConfigDirs)).args[5] ?? "";
    expect(cmd).not.toMatch(/\bstat\b/);
    expect(cmd).not.toMatch(/\btimeout\b/);
    expect(cmd).not.toContain("-w0");
    expect(cmd).toContain("tr -d");
  });
});

describe("buildRoundT", () => {
  it("maps tool tokens from config: herdrBin+socket unquoted, spawnCommand for claude", () => {
    const { spec, tools } = buildRoundT(env);
    const cmd = spec.args[5] ?? "";
    expect(cmd).toContain("HERDR_SOCKET_PATH=~/s.sock ~/.local/bin/herdr --version");
    expect(cmd).toContain("claude --version");
    expect(cmd).toContain("CLAUDE_CONFIG_DIR="); // one integration probe per config dir
    expect(tools.map((t) => t.signature)).toEqual([
      "herdr --version", "claude --version", "herdr integration status@/far/.claude",
    ]);
  });

  it("with no config dirs emits one env-scoped integration probe", () => {
    const bare = { ...env, claudeConfigDirs: [] };
    const { tools } = buildRoundT(bare);
    expect(tools.map((t) => t.signature)).toEqual([
      "herdr --version", "claude --version", "herdr integration status",
    ]);
  });
});

describe("screenRound2Path", () => {
  it("screens metacharacters and control chars rejected, spaces accepted, absolute required", () => {
    expect(screenRound2Path("/Users/o p/Library/statusline.sh")).toBe(true);
    expect(screenRound2Path("/tmp/x;rm -rf ~")).toBe(false);
    expect(screenRound2Path("/tmp/$(x)")).toBe(false);
    expect(screenRound2Path("/tmp/a\tb")).toBe(false);
    expect(screenRound2Path("/tmp/a\nb")).toBe(false);
    expect(screenRound2Path("relative.sh")).toBe(false);
    expect(screenRound2Path("")).toBe(false);
  });
});

describe("buildRound2", () => {
  it("quotes every path with shell-quote and splits over the command-length bound", () => {
    const reqs = Array.from({ length: 4000 }, (_, i) =>
      ({ key: `r2_${String(i)}`, kind: "file" as const, path: `/very/long/path/number/${String(i)}/statusline command.sh` }));
    const specs = buildRound2(env, reqs);
    expect(specs.length).toBeGreaterThan(1);
    for (const s of specs) expect((s.args[5] ?? "").length).toBeLessThanOrEqual(100_000);
    expect(specs[0]?.args[5]).toContain("'/very/long/path/number/0/statusline command.sh'");
  });

  it("a metacharacter payload cannot escape quote() — the composed command carries it inert", () => {
    const specs = buildRound2(env, [{ key: "r2_0", kind: "file", path: "/tmp/a b" }]);
    const cmd = specs[0]?.args[5] ?? "";
    expect(cmd).toContain("'/tmp/a b'");
  });
});

describe("the composed round-F script, executed under a local sh (no ssh)", () => {
  it("answers a real fixture dir end-to-end: content, exec bit, too-large, unreadable, absent, not-regular — and exits 0", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "probe-f-"));
    await writeFile(path.join(dir, "settings.json"), "{}", { mode: 0o755 });         // content + exec bit, together
    // corral-status-capture.sh deliberately NOT created — this is the fixture's `!absent` case.
    // Stage 1's live fleet run showed "not installed" is the single most common real-world state,
    // so this branch of ef() must be exercised end-to-end under a real shell, not only by Task 3's
    // canned-string unit test.
    await mkdir(path.join(dir, "skills/corral"), { recursive: true });
    await writeFile(path.join(dir, "skills/corral/SKILL.md"), Buffer.alloc(MAX_READABLE_BYTES + 1)); // over-cap
    await writeFile(path.join(dir, "corral-claude-hook.sh"), "x", { mode: 0o000 }); // unreadable
    await mkdir(path.join(dir, "themes"));                                          // a DIR at a file path → not-regular
    await mkdir(path.join(dir, "themes/corral.json"));
    const manifest = buildManifest([dir]);
    const spec = buildRoundF({ ...env, claudeConfigDirs: [dir] }, manifest);
    const script = spec.args[5] ?? "";
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("sh", ["-c", script], { maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
        if (err) reject(new Error(err.message)); else resolve(out); // non-zero exit = the design's unconditional-success rule broke
      });
    });
    const parsed = parseWire(stdout, spec.expectedKeys, PROBE_TOTAL_CAP_BYTES);
    const byPath = new Map(manifest.entries.map((e) => [e.path, parsed.answers.get(e.key)]));
    expect(byPath.get(`${dir}/settings.json`)).toEqual({ kind: "content", bytes: Buffer.from("{}"), executable: true });
    expect(byPath.get(`${dir}/corral-status-capture.sh`)).toEqual({ kind: "absent" });
    expect(byPath.get(`${dir}/skills/corral/SKILL.md`)).toEqual({ kind: "too-large", executable: false });
    if (process.getuid?.() !== 0) { // root reads anything — the chmod-000 leg is meaningless there
      expect(byPath.get(`${dir}/corral-claude-hook.sh`)).toEqual({ kind: "unreadable", executable: false });
    }
    expect(byPath.get(`${dir}/themes/corral.json`)).toEqual({ kind: "not-regular" });
    expect(byPath.get(dir)).toEqual({ kind: "dir", exists: true });
    // Every jq candidate is absent on this fixture host's standard dirs OR genuinely present —
    // either way it ANSWERS (the jq-less-host bullet: a missing tool never breaks the round):
    for (const d of STANDARD_BIN_DIRS) expect(parsed.answers.has(
      manifest.entries.find((e) => e.path === `${d}/jq`)?.key ?? "")).toBe(true);
    expect(byPath.get("$HOME")?.kind).toBe("value");
    await rm(dir, { recursive: true, force: true });
  });
});
