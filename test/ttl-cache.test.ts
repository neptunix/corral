import { describe, it, expect } from "vitest";

import { createTtlCache } from "../server/ttl-cache.ts";

describe("createTtlCache", () => {
  it("returns a stored value within the TTL and undefined after it expires", () => {
    let t = 1000;
    const c = createTtlCache<number>({ ttlMs: 100, now: () => t });
    c.set("k", 42);
    expect(c.get("k")).toBe(42);
    t = 1099;
    expect(c.get("k")).toBe(42); // still within TTL
    t = 1100;
    expect(c.get("k")).toBeUndefined(); // now >= ttl → expired
  });

  it("distinguishes an absent key (undefined) from a cached null value", () => {
    const c = createTtlCache<number | null>({ ttlMs: 1000, now: () => 0 });
    expect(c.get("absent")).toBeUndefined();
    c.set("k", null);
    expect(c.get("k")).toBeNull(); // a cached null is a hit, not a miss
  });

  it("evicts the oldest entry when it grows past maxEntries", () => {
    let t = 0;
    const c = createTtlCache<number>({ ttlMs: 1_000_000, maxEntries: 2, now: () => t });
    c.set("a", 1);
    t = 1;
    c.set("b", 2);
    t = 2;
    c.set("c", 3); // over cap, none expired → evict oldest live entry "a"
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    expect(c.get("c")).toBe(3);
    expect(c.size).toBeLessThanOrEqual(2);
  });

  it("reclaims expired entries before evicting live ones when over the cap", () => {
    let t = 0;
    const c = createTtlCache<number>({ ttlMs: 10, maxEntries: 2, now: () => t });
    c.set("stale", 1); // at t=0
    t = 20; // "stale" is now expired
    c.set("b", 2);
    c.set("c", 3); // size 3 > 2 → prune expired "stale" first; "b"/"c" survive
    expect(c.get("stale")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    expect(c.get("c")).toBe(3);
  });
});
