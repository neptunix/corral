import { describe, expect, it } from "vitest";

import { createRecapCache } from "../server/recap.ts";

describe("RecapCache", () => {
  it("update + get returns stored recap", () => {
    const cache = createRecapCache();
    cache.update("a:p1", "sess-1", "hello", "ok");
    const entry = cache.get("a:p1");
    expect(entry?.recap).toBe("hello");
    expect(entry?.sessionId).toBe("sess-1");
    expect(entry?.status).toBe("ok");
    expect(typeof entry?.at).toBe("number");
  });

  it("get returns null for unknown key", () => {
    const cache = createRecapCache();
    expect(cache.get("nope")).toBeNull();
  });

  it("null recap keeps prior recap but updates status (transient miss)", () => {
    const cache = createRecapCache();
    cache.update("a:p1", "sess-1", "original", "ok");
    cache.update("a:p1", "sess-1", null, "no-summary");
    const entry = cache.get("a:p1");
    expect(entry?.recap).toBe("original");
    expect(entry?.status).toBe("no-summary");
  });

  it("sessionId change drops old entry when recap is null", () => {
    const cache = createRecapCache();
    cache.update("a:p1", "sess-1", "old", "ok");
    cache.update("a:p1", "sess-2", null, "not-found");
    expect(cache.get("a:p1")).toBeNull();
  });

  it("sessionId change with new non-null recap stores fresh entry", () => {
    const cache = createRecapCache();
    cache.update("a:p1", "sess-1", "old", "ok");
    cache.update("a:p1", "sess-2", "new", "ok");
    const entry = cache.get("a:p1");
    expect(entry?.recap).toBe("new");
    expect(entry?.sessionId).toBe("sess-2");
  });

  it("prune removes entries for gone panes, keeps live ones", () => {
    const cache = createRecapCache();
    cache.update("a:p1", "sess-1", "r1", "ok");
    cache.update("a:p2", "sess-2", "r2", "ok");
    cache.prune(new Set(["a:p1"]));
    expect(cache.get("a:p1")?.recap).toBe("r1");
    expect(cache.get("a:p2")).toBeNull();
  });

  it("null recap when no prior entry does nothing", () => {
    const cache = createRecapCache();
    cache.update("a:p1", "sess-1", null, "not-found");
    expect(cache.get("a:p1")).toBeNull();
  });
});
