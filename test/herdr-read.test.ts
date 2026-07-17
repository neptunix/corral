import { describe, it, expect, vi } from "vitest";

import { getEnv } from "../environments.ts";
import { readPane, type ExecFn } from "../server/herdr.ts";

describe("readPane", () => {
  it("returns raw text plus parsed ctx/model", async () => {
    const exec: ExecFn = vi.fn(() => Promise.resolve({ stdout: "ctx ░░ 19% (190K) | Sonnet 1M\nworking...", stderr: "" }));
    const r = await readPane(getEnv("work-local"), "w1-1", 50, exec);
    expect(r.text).toContain("working...");
    expect(r.ctxPct).toBe("19");
    expect(r.model).toBe("Sonnet 1M");
    expect(exec).toHaveBeenCalledWith(
      "herdr", ["pane", "read", "w1-1", "--source", "recent", "--lines", "50"], expect.anything(),
    );
  });
});
