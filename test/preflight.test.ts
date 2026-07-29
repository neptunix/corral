import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { buildAttachSpec, buildExec } from "../server/herdr.ts";
import { findMissingBinaries, isExecutableFile, missingBinaryMessage, resolveOnPath } from "../server/preflight.ts";

const local = (id: string): HerdrEnv => ({
  id, label: id.toUpperCase(), kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {},
});
const remote = (id: string): HerdrEnv => ({
  id, label: id.toUpperCase(), kind: "remote", sshHost: "h", socket: "~/s.sock", herdrBin: "herdr",
  claudeConfigDirs: [], spawnCommand: "claude", repos: {},
});
const P = (...dirs: string[]): string => dirs.join(path.delimiter);

describe("resolveOnPath", () => {
  it("walks PATH in order and returns the first executable hit", () => {
    const execs = new Set([path.join("/b", "herdr"), path.join("/c", "herdr")]);
    expect(resolveOnPath("herdr", P("/a", "/b", "/c"), (p) => execs.has(p))).toBe(path.join("/b", "herdr"));
  });

  it("returns null when no PATH entry holds an executable of that name", () => {
    // The whole point: this is what the server's own environment looks like when it was started from
    // a non-interactive shell that never put ~/.local/bin on PATH.
    expect(resolveOnPath("herdr", P("/usr/bin", "/bin"), () => false)).toBeNull();
  });

  it("skips empty PATH entries rather than probing the process cwd", () => {
    // An empty entry means "cwd" to some shells; treating it as one would make resolution depend on
    // where the server happened to be started, which is exactly the class of surprise this guards.
    const probed: string[] = [];
    resolveOnPath("herdr", P("", "/bin"), (p) => { probed.push(p); return false; });
    expect(probed).toEqual([path.join("/bin", "herdr")]);
  });

});

describe("isExecutableFile (the real filesystem predicate)", () => {
  // The one part of preflight that touches the filesystem, and the switch deciding whether the warning
  // fires at all. Every resolveOnPath test injects a fake predicate, so without these the real one is
  // exercised by nothing.
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "preflight-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("rejects a DIRECTORY named like the binary", () => {
    // Load-bearing and non-obvious: accessSync(<dir>, X_OK) SUCCEEDS, because on a directory the
    // execute bit means "searchable". Without the isFile() guard a directory called `herdr` on PATH
    // would count as a resolved binary — preflight would print nothing while every attach still died.
    mkdirSync(path.join(dir, "herdr"));
    expect(isExecutableFile(path.join(dir, "herdr"))).toBe(false);
  });

  it("accepts a regular file with the execute bit", () => {
    const f = path.join(dir, "herdr");
    writeFileSync(f, "#!/bin/sh\n");
    chmodSync(f, 0o755);
    expect(isExecutableFile(f)).toBe(true);
  });

  it("rejects a present but non-executable file", () => {
    if (process.getuid?.() === 0) return; // root ignores the execute bit, so the assertion is meaningless
    const f = path.join(dir, "herdr");
    writeFileSync(f, "#!/bin/sh\n");
    chmodSync(f, 0o644);
    expect(isExecutableFile(f)).toBe(false);
  });

  it("returns false instead of throwing for a missing path or a dangling symlink", () => {
    expect(isExecutableFile(path.join(dir, "nope"))).toBe(false);
    const link = path.join(dir, "dangling");
    symlinkSync(path.join(dir, "nope"), link);
    expect(isExecutableFile(link)).toBe(false); // statSync follows the link and throws → caught
  });
});

describe("findMissingBinaries", () => {
  it("reports herdr for a local env, since that is the bare name handed to exec and node-pty", () => {
    expect(findMissingBinaries([local("a")], () => null)).toEqual([{ bin: "herdr", envIds: ["a"] }]);
  });

  it("reports ssh for a remote env — herdrBin runs on the far side, not here", () => {
    expect(findMissingBinaries([remote("r")], () => null)).toEqual([{ bin: "ssh", envIds: ["r"] }]);
  });

  it("groups every env that needs the same missing binary into one finding", () => {
    const found = findMissingBinaries([local("a"), local("b"), remote("r")], (bin) => (bin === "ssh" ? "/usr/bin/ssh" : null));
    expect(found).toEqual([{ bin: "herdr", envIds: ["a", "b"] }]);
  });

  it("returns nothing when every needed binary resolves", () => {
    expect(findMissingBinaries([local("a"), remote("r")], (bin) => `/usr/bin/${bin}`)).toEqual([]);
  });

  it("checks exactly the binary buildExec and buildAttachSpec hand to execFile and node-pty", () => {
    // This mapping is stated twice — here and in server/herdr.ts. Asserting the literals against
    // themselves could never catch drift, and drift is silent in both directions: preflight checking a
    // name nothing execs prints nothing when the real binary is missing, or fires on every startup and
    // trains the operator to ignore the line. Pin it to the real call sites instead.
    for (const env of [local("a"), remote("r")]) {
      const found = findMissingBinaries([env], () => null);
      expect(found).toHaveLength(1);
      const bin = found[0]?.bin;
      expect(buildExec(env, ["agent", "list"], 1000).file).toBe(bin);
      expect(buildAttachSpec(env, "w1-1", true).file).toBe(bin);
    }
  });
});

describe("missingBinaryMessage", () => {
  it("names the binary, the affected envs and the PATH actually searched", () => {
    // The PATH matters more than anything else in the line: the operator's own shell resolves the
    // binary fine, so without the server's PATH the report looks impossible and gets dismissed.
    const msg = missingBinaryMessage({ bin: "herdr", envIds: ["a", "b"] }, P("/usr/bin", "/bin"));
    expect(msg).toContain("herdr");
    expect(msg).toContain("a, b");
    expect(msg).toContain(P("/usr/bin", "/bin"));
  });

  it("says what breaks, so the line is actionable on its own", () => {
    const msg = missingBinaryMessage({ bin: "herdr", envIds: ["a"] }, "/bin");
    expect(msg.toLowerCase()).toContain("attach");
  });
});
