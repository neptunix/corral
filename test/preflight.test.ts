import path from "node:path";
import { describe, it, expect } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { findMissingBinaries, missingBinaryMessage, resolveOnPath } from "../server/preflight.ts";

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

  it("uses a name containing a separator as-is, like execvp does", () => {
    const abs = path.join("/opt", "herdr");
    expect(resolveOnPath(abs, P("/bin"), (p) => p === abs)).toBe(abs);
    expect(resolveOnPath(abs, P("/bin"), () => false)).toBeNull();
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
