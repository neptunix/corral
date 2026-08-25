// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { markLogSeen, newSince, readLogSeen } from "../web/src/lib/log-seen";

afterEach(() => { window.localStorage.clear(); });

describe("newSince — what the badge reads from the two counters", () => {
  it("a card never opened: everything is new", () => {
    expect(newSince({ logCount: 9, lastLogAtMs: 5_000 }, undefined)).toBe(9);
  });
  it("nothing new when the last entry displayed is the last entry written — a count-only comparison would miss this", () => {
    expect(newSince({ logCount: 9, lastLogAtMs: 5_000 }, { count: 9, atMs: 5_000 })).toBe(0);
  });
  it("the count difference when newer entries exist", () => {
    expect(newSince({ logCount: 9, lastLogAtMs: 6_000 }, { count: 6, atMs: 5_000 })).toBe(3);
  });
  it("eviction hid the count growth, the timestamp still says something landed: at least one, never zero", () => {
    expect(newSince({ logCount: 200, lastLogAtMs: 6_000 }, { count: 200, atMs: 5_000 })).toBe(1);
  });
  it("an empty log is never \"new\", whatever was remembered", () => {
    expect(newSince({ logCount: 0, lastLogAtMs: null }, undefined)).toBe(0);
    expect(newSince({ logCount: 0, lastLogAtMs: null }, { count: 3, atMs: 5_000 })).toBe(0);
  });
});

describe("markLogSeen / readLogSeen", () => {
  it("what is marked on one card does not answer for another", () => {
    markLogSeen("b1/t1", { count: 4, atMs: 100 });
    expect(readLogSeen("b1/t1")).toEqual({ count: 4, atMs: 100 });
    expect(readLogSeen("b1/t2")).toBeUndefined();
  });
  it("a corrupt store reads as never-seen instead of throwing", () => {
    window.localStorage.setItem("corral.log.seen", "{not json");
    expect(readLogSeen("b1/t1")).toBeUndefined();
    window.localStorage.setItem("corral.log.seen", JSON.stringify({ "b1/t1": { count: "four" } }));
    expect(readLogSeen("b1/t1")).toBeUndefined();
  });
  it("a corrupt store is replaced by the next mark, not appended to", () => {
    window.localStorage.setItem("corral.log.seen", "{not json");
    markLogSeen("b1/t1", { count: 1, atMs: 1 });
    expect(readLogSeen("b1/t1")).toEqual({ count: 1, atMs: 1 });
  });
  it("marking one card keeps the others", () => {
    markLogSeen("b1/t1", { count: 1, atMs: 1 });
    markLogSeen("b1/t2", { count: 2, atMs: 2 });
    expect(readLogSeen("b1/t1")).toEqual({ count: 1, atMs: 1 });
  });
  it("re-marking a card makes it the newest — it is not evicted on its first-mark age", () => {
    markLogSeen("b/old", { count: 1, atMs: 1 });
    for (let i = 1; i < 500; i++) markLogSeen(`b/t${String(i)}`, { count: 1, atMs: i });
    markLogSeen("b/old", { count: 2, atMs: 600 });
    markLogSeen("b/t500", { count: 1, atMs: 601 }); // the 501st evicts exactly one
    expect(readLogSeen("b/old")).toEqual({ count: 2, atMs: 600 });
    expect(readLogSeen("b/t1")).toBeUndefined();
  });
  it("the store is bounded — the oldest marks go first, the one just written stays", () => {
    for (let i = 0; i < 600; i++) markLogSeen(`b/t${String(i)}`, { count: 1, atMs: i });
    expect(readLogSeen("b/t0")).toBeUndefined();
    expect(readLogSeen("b/t599")).toEqual({ count: 1, atMs: 599 });
  });
});
