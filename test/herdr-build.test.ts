import os from "node:os";
import { describe, it, expect } from "vitest";

import { getEnv } from "../environments.ts";
import { buildAttachSpec, buildExec, expandTilde } from "../server/herdr.ts";

describe("buildExec", () => {
  it("local env: plain herdr call, no socket env", () => {
    const spec = buildExec(getEnv("work-local"), ["agent", "list"], 15000);
    expect(spec.file).toBe("herdr");
    expect(spec.args).toEqual(["agent", "list"]);
    expect(spec.options.env?.HERDR_SOCKET_PATH).toBeUndefined();
    expect(spec.options.timeout).toBe(15000);
  });

  it("local-with-socket env: tilde-expanded HERDR_SOCKET_PATH", () => {
    const spec = buildExec(getEnv("personal-local"), ["agent", "list"], 15000);
    expect(spec.options.env?.HERDR_SOCKET_PATH).toBe(os.homedir() + "/.config/herdr/sessions/personal/herdr.sock");
  });

  it("remote env: ssh with ConnectTimeout + assembled command", () => {
    const spec = buildExec(getEnv("work-remote"), ["agent", "list"], 15000);
    expect(spec.file).toBe("ssh");
    expect(spec.args.slice(0, 3)).toEqual(["-o", "ConnectTimeout=8", "work-box"]);
    expect(spec.args[3]!).toBe(
      "HERDR_SOCKET_PATH=~/.config/herdr/sessions/work/herdr.sock ~/.local/bin/herdr agent list",
    );
  });

  it("remote env: shell-quotes hostile tokens", () => {
    const spec = buildExec(getEnv("work-remote"), ["pane", "run", "w1-1", "x; rm -rf /"], 30000);
    expect(spec.args[3]!).toContain("pane run w1-1 'x; rm -rf /'");
    expect(spec.args[3]!).not.toMatch(/herdr pane run w1-1 x; rm/);
  });

  it("expandTilde leaves non-tilde paths untouched", () => {
    expect(expandTilde("/abs/path")).toBe("/abs/path");
  });
});

// buildAttachSpec builds the argv for a PTY-hosted `herdr agent attach`. Task 0 (empirical, herdr
// 0.7.1) corrected the CLI syntax: the attach target is a PLAIN POSITIONAL arg — there is NO `--`
// guard (`attach -- <paneId>` errors "unknown option" on 0.7.1). Option-injection via a leading-dash
// paneId is instead prevented upstream by the tightened PANE_RE in validateUpgrade (Task 8), which is
// the load-bearing SEC-4 control now that `--` is gone. Input ownership uses herdr's native
// `--takeover` (Task 0 decision: full bidirectional), passed as an optional flag.
describe("buildAttachSpec", () => {
  it("local without socket: positional paneId, no `--`, no socket env", () => {
    const s = buildAttachSpec(getEnv("work-local"), "w653-1");
    expect(s.file).toBe("herdr");
    expect(s.args).toEqual(["agent", "attach", "w653-1"]);
    expect(s.env).toBeUndefined();
  });

  it("local with takeover appends --takeover after the paneId", () => {
    const s = buildAttachSpec(getEnv("work-local"), "w653-1", true);
    expect(s.args).toEqual(["agent", "attach", "w653-1", "--takeover"]);
  });

  it("local with socket sets a tilde-expanded HERDR_SOCKET_PATH", () => {
    const s = buildAttachSpec(getEnv("personal-local"), "p1");
    expect(s.env?.HERDR_SOCKET_PATH).toBe(os.homedir() + "/.config/herdr/sessions/personal/herdr.sock");
  });

  it("remote: ssh -tt + keepalives + strict host key + assignment OUTSIDE quote()", () => {
    const s = buildAttachSpec(getEnv("work-remote"), "w1-1");
    expect(s.file).toBe("ssh");
    expect(s.args).toContain("-tt");
    expect(s.args).toContain("ServerAliveInterval=15");
    expect(s.args).toContain("ServerAliveCountMax=2");
    expect(s.args).toContain("StrictHostKeyChecking=yes");
    // Last arg is the inner remote command: the env assignment + trusted socket/herdrBin stay OUTSIDE
    // quote() (so the REMOTE shell expands ~ in the socket); no `--`; paneId is a bare positional.
    const inner = s.args[s.args.length - 1] ?? "";
    expect(inner).toBe(
      "HERDR_SOCKET_PATH=~/.config/herdr/sessions/work/herdr.sock ~/.local/bin/herdr agent attach w1-1",
    );
  });

  it("remote with takeover appends --takeover to the inner command", () => {
    const s = buildAttachSpec(getEnv("work-remote"), "w1-1", true);
    const inner = s.args[s.args.length - 1] ?? "";
    expect(inner).toBe(
      "HERDR_SOCKET_PATH=~/.config/herdr/sessions/work/herdr.sock ~/.local/bin/herdr agent attach w1-1 --takeover",
    );
  });

  it("remote shell-quotes the paneId but never the trusted assignment", () => {
    // Defense-in-depth: even though PANE_RE blocks metacharacters upstream, quote() must wrap the
    // user token if it ever contained one — while the assignment/socket stay unquoted for ~ expansion.
    const s = buildAttachSpec(getEnv("work-remote"), "a b");
    const inner = s.args[s.args.length - 1] ?? "";
    expect(inner).toContain("agent attach 'a b'");
    expect(inner.startsWith("HERDR_SOCKET_PATH=~/.config/herdr/sessions/work/herdr.sock")).toBe(true);
  });
});
