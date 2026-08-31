import { describe, it, expect, vi } from "vitest";

import { getEnv } from "../environments.ts";
import { runHerdr, defaultExec, type ExecFn } from "../server/herdr.ts";

describe("runHerdr", () => {
  it("returns local stdout unchanged", async () => {
    const exec: ExecFn = vi.fn(async () => ({ stdout: '{"result":{}}', stderr: "" }));
    const out = await runHerdr(getEnv("work-local"), ["agent", "list"], { timeout: 1000, exec });
    expect(out).toBe('{"result":{}}');
    expect(exec).toHaveBeenCalledWith("herdr", ["agent", "list"], expect.objectContaining({ timeout: 1000 }));
  });

  it("strips SSH-noise lines from remote stdout without trimming pane text", async () => {
    const exec: ExecFn = vi.fn(async () => ({
      stdout: "Warning: remote port forwarding failed\nline one\n  line two  \n",
      stderr: "",
    }));
    const out = await runHerdr(getEnv("work-remote"), ["pane", "read", "w1-1"], { timeout: 1000, exec });
    expect(out).not.toContain("Warning");
    expect(out).toContain("line one");
    expect(out).toContain("  line two  "); // internal/edge whitespace preserved (no blanket trim)
  });

  it("forwards closeStdin to the exec fn", async () => {
    let seen: boolean | undefined;
    const exec: ExecFn = async (_f, _a, options) => { seen = options.closeStdin; return { stdout: "", stderr: "" }; };
    await runHerdr(getEnv("work-local"), ["pane", "list"], { timeout: 1000, exec, closeStdin: true });
    expect(seen).toBe(true);
  });

  it("omits closeStdin when not asked", async () => {
    let seen: boolean | undefined;
    const exec: ExecFn = async (_f, _a, options) => { seen = options.closeStdin; return { stdout: "", stderr: "" }; };
    await runHerdr(getEnv("work-local"), ["pane", "list"], { timeout: 1000, exec });
    expect(seen).toBeUndefined();
  });
});

describe("defaultExec", () => {
  // Real child process, no mock: this is the one test proving `closeStdin` reaches the actual pipe
  // rather than just the type. `cat` echoes stdin back and exits on EOF, so it resolves iff stdin is
  // ended, and hangs (until the timeout kills it) iff the pipe is left open.
  it("ends stdin when closeStdin is set — cat exits on EOF", async () => {
    await expect(defaultExec("cat", [], { timeout: 2000, closeStdin: true })).resolves.toEqual({ stdout: "", stderr: "" });
  });

  it("leaves stdin open otherwise — cat hangs until the timeout kills it", async () => {
    await expect(defaultExec("cat", [], { timeout: 300 })).rejects.toThrow();
  });
});
