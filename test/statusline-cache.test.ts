import type { StatuslineData } from "@shared/schema";
import { describe, expect, it } from "vitest";

import { createStatuslineCache } from "../server/statusline-cache.ts";

const data = (n: number): StatuslineData => ({
  v: 1, captured_at: n, session_id: "s1", session_name: null, name_source: null, account: null,
  model: "Opus", model_id: null, ctx: { pct: n, tokens: null, window: null },
  cost: { usd: null, lines_added: null, lines_removed: null },
  rate: { five_hour: null, seven_day: null }, effort: null, thinking: null, cc_version: null,
});

describe("statusline cache", () => {
  it("stores and returns the latest data", () => {
    const c = createStatuslineCache();
    c.update("k", "s1", data(1), "ok");
    expect(c.get("k")?.data?.ctx.pct).toBe(1);
    expect(c.get("k")?.status).toBe("ok");
  });

  it("keeps last-good data but updates status when new data is null", () => {
    const c = createStatuslineCache();
    c.update("k", "s1", data(1), "ok");
    c.update("k", "s1", null, "not-found");
    expect(c.get("k")?.data?.ctx.pct).toBe(1);
    expect(c.get("k")?.status).toBe("not-found");
  });

  it("drops the entry when sessionId changes", () => {
    const c = createStatuslineCache();
    c.update("k", "s1", data(1), "ok");
    c.update("k", "s2", data(2), "ok");
    expect(c.get("k")?.data?.ctx.pct).toBe(2);
  });

  it("prunes keys not in the live set", () => {
    const c = createStatuslineCache();
    c.update("k", "s1", data(1), "ok");
    c.prune(new Set());
    expect(c.get("k")).toBeNull();
  });
});
