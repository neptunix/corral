import { describe, it, expect } from "vitest";

import { runLocalTool } from "../server/exec-tool.ts";

describe("runLocalTool", () => {
  it("returns stdout for a successful run", async () => {
    expect((await runLocalTool("printf", ["hello"]))).toBe("hello");
  });

  it("passes an extra environment variable to the child", async () => {
    const out = await runLocalTool("sh", ["-c", 'printf %s "$CLAUDE_CONFIG_DIR"'], { extraEnv: { CLAUDE_CONFIG_DIR: "/tmp/x" } });
    expect(out).toBe("/tmp/x");
  });

  it("returns null on a non-zero exit rather than throwing", async () => {
    expect(await runLocalTool("sh", ["-c", "exit 3"])).toBe(null);
  });

  it("returns null when the binary does not exist", async () => {
    expect(await runLocalTool("corral-no-such-binary", [])).toBe(null);
  });

  it("returns null on timeout instead of hanging a sweep", async () => {
    expect(await runLocalTool("sleep", ["5"], { timeoutMs: 50 })).toBe(null);
  });

  it("does not interpret arguments through a shell", async () => {
    expect(await runLocalTool("printf", ["%s", "a; rm -rf /tmp/nope"])).toBe("a; rm -rf /tmp/nope");
  });
});
