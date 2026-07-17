import { describe, it, expect, vi } from "vitest";

import { getEnv } from "../environments.ts";
import { runHerdr, type ExecFn } from "../server/herdr.ts";

describe("runHerdr", () => {
  it("returns local stdout unchanged", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const exec: ExecFn = vi.fn(async () => ({ stdout: '{"result":{}}', stderr: "" }));
    const out = await runHerdr(getEnv("work-local"), ["agent", "list"], { timeout: 1000, exec });
    expect(out).toBe('{"result":{}}');
    expect(exec).toHaveBeenCalledWith("herdr", ["agent", "list"], expect.objectContaining({ timeout: 1000 }));
  });

  it("strips SSH-noise lines from remote stdout without trimming pane text", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const exec: ExecFn = vi.fn(async () => ({
      stdout: "Warning: remote port forwarding failed\nline one\n  line two  \n",
      stderr: "",
    }));
    const out = await runHerdr(getEnv("work-remote"), ["pane", "read", "w1-1"], { timeout: 1000, exec });
    expect(out).not.toContain("Warning");
    expect(out).toContain("line one");
    expect(out).toContain("  line two  "); // internal/edge whitespace preserved (no blanket trim)
  });
});
