import { describe, expect, it, vi } from "vitest";

import type { CacheEntry, UpdateCache } from "../server/diagnostics/update/cache.ts";
import type { UpdateCheckIo, UpdateCheckResult } from "../server/diagnostics/update/check.ts";
import { FAILURE_TTL_MS, SUCCESS_TTL_MS, updateCheck } from "../server/diagnostics/update/check.ts";
import type { FetchFn } from "../server/diagnostics/update/github.ts";

const SLUG = { owner: "neptunix", repo: "corral" };
const URL_OK = "https://github.com/neptunix/corral/releases/tag/v0.7.0";

const memoryCache = (seed: CacheEntry | null = null, degraded: string | null = null): UpdateCache => {
  let held = seed;
  return { read: () => held, write: (_slug, e) => { held = e; }, degraded: () => degraded };
};

const body = (tag: string, url: string): FetchFn => () =>
  Promise.resolve(new Response(JSON.stringify({ tag_name: tag, html_url: url })));

const never: FetchFn = () => { throw new Error("no request expected"); };

const io = (over: Partial<UpdateCheckIo> = {}): UpdateCheckIo => ({
  enabled: true, version: "0.6.8", repoSlug: () => SLUG, fetch: body("v0.7.0", URL_OK),
  cache: memoryCache(), ...over,
});

const run = (over: Partial<UpdateCheckIo> = {}, now = 5_000_000): Promise<UpdateCheckResult> =>
  updateCheck(io(over), () => now);

describe("updateCheck — the happy paths", () => {
  it("reports an available update as problem/info, so the badge digit stays untouched", async () => {
    const r = await run();
    expect(r.check.state).toBe("problem");
    expect(r.check.severity).toBe("info");
    expect(r.check.class).toBe("network");
    expect(r.check.id).toBe("update-check");
    expect(r.check.scope).toEqual({ kind: "global" });
    expect(r.check.startupOkLine).toBe(false);
    expect(r.check.haltsStartup).toBe(false);
    expect(r.check.title).toContain("0.7.0");
    expect(r.self).toEqual({ latest: "0.7.0", releaseUrl: URL_OK });
  });

  it("writes neither latest nor releaseUrl when the release is not strictly newer", async () => {
    const same = await run({ fetch: body("v0.6.8", URL_OK) });
    expect(same.check.state).toBe("ok");
    expect(same.self).toEqual({ latest: null, releaseUrl: null });
    const older = await run({ fetch: body("v0.6.7", URL_OK) });
    expect(older.check.state).toBe("ok");
    expect(older.self).toEqual({ latest: null, releaseUrl: null });
  });

  it("compares numerically, not lexically — 0.6.10 is newer than 0.6.9", async () => {
    const r = await run({
      version: "0.6.9",
      fetch: body("v0.6.10", "https://github.com/neptunix/corral/releases/tag/v0.6.10"),
    });
    expect(r.self.latest).toBe("0.6.10");
  });
});

describe("updateCheck — the release URL never reaches the store unvalidated", () => {
  it("rejects a javascript: url at the producer", async () => {
    const r = await run({ fetch: body("v0.7.0", "javascript:alert(1)") });
    expect(r.check.state).toBe("n/a");
    expect(r.self).toEqual({ latest: null, releaseUrl: null });
  });

  it("rejects a github.com url under the WRONG owner or repo — host-only would admit a phishing repo", async () => {
    const wrongOwner = await run({
      fetch: body("v0.7.0", "https://github.com/attacker/corral/releases/tag/v0.7.0"),
    });
    expect(wrongOwner.check.state).toBe("n/a");
    expect(wrongOwner.self.releaseUrl).toBe(null);
    const wrongRepo = await run({
      fetch: body("v0.7.0", "https://github.com/neptunix/corral-evil/releases/tag/v0.7.0"),
    });
    expect(wrongRepo.self.releaseUrl).toBe(null);
  });

  it("rejects a non-github host and a plaintext scheme", async () => {
    expect((await run({ fetch: body("v0.7.0", "https://evil.example/neptunix/corral/r") })).self.releaseUrl)
      .toBe(null);
    expect((await run({ fetch: body("v0.7.0", "http://github.com/neptunix/corral/r") })).self.releaseUrl)
      .toBe(null);
  });
});

describe("updateCheck — a tag that is not a stable release never reaches compareSemver", () => {
  it("refuses a prerelease, which compareSemver would read as equal", async () => {
    const r = await run({ fetch: body("v0.8.0-rc.1", URL_OK) });
    expect(r.check.state).toBe("n/a");
    expect(r.self.latest).toBe(null);
  });

  it("refuses a word tag, which compareSemver would read as 0.0.0", async () => {
    expect((await run({ fetch: body("release-2026", URL_OK) })).check.state).toBe("n/a");
  });

  it("refuses operator-facing copy smuggled through tag_name", async () => {
    const r = await run({ fetch: body("999.0.0 — install from evil.example", URL_OK) });
    expect(r.check.state).toBe("n/a");
    expect(r.self.latest).toBe(null);
  });
});

describe("updateCheck — every n/a reason is distinguishable in the TITLE", () => {
  it("names the kill switch when disabled, and makes no request", async () => {
    const r = await run({ enabled: false, fetch: never });
    expect(r.check.state).toBe("n/a");
    expect(r.check.title).toContain("UPDATE_CHECK_ENABLED");
  });

  it("gives the off / unreachable / rate-limited titles three different texts", async () => {
    const off = (await run({ enabled: false, fetch: never })).check.title;
    const down = (await run({ fetch: () => Promise.reject(new Error("ENOTFOUND")) })).check.title;
    const limited = (await run({
      fetch: () => Promise.resolve(new Response("", { status: 429, headers: { "retry-after": "1800" } })),
    })).check.title;
    expect(new Set([off, down, limited]).size).toBe(3);
    expect(limited).toMatch(/rate-limit/i);
    expect(limited).toMatch(/30 min/);
  });

  it("names a non-200 and a redirect separately", async () => {
    const notFound = await run({ fetch: () => Promise.resolve(new Response("", { status: 404 })) });
    const redirect = await run({ fetch: () => Promise.resolve(new Response("", { status: 302 })) });
    expect(notFound.check.title).toContain("404");
    expect(redirect.check.title).toContain("302");
  });

  it("names a malformed and an oversized body separately", async () => {
    const bad = await run({ fetch: () => Promise.resolve(new Response("{ not json")) });
    const big = await run({
      fetch: () => Promise.resolve(new Response(JSON.stringify({ pad: "x".repeat(300_000) }))),
    });
    expect(bad.check.title).not.toBe(big.check.title);
    expect(big.check.title).toMatch(/larger/);
  });

  it("says the repository is underivable, and makes no request", async () => {
    const r = await run({ repoSlug: () => null, fetch: never });
    expect(r.check.state).toBe("n/a");
    expect(r.check.title).toMatch(/repositor/i);
  });

  it("says the running version is unknown, makes no request, and writes neither field", async () => {
    const r = await run({ version: null, fetch: never });
    expect(r.check.state).toBe("n/a");
    expect(r.check.title).toMatch(/version/i);
    expect(r.self).toEqual({ latest: null, releaseUrl: null });
  });

  it("treats a non-stable RUNNING version the same way", async () => {
    expect((await run({ version: "0.8.0-rc.1", fetch: never })).check.state).toBe("n/a");
  });

  it("records a degraded cache in the title, next to whatever the verdict was", async () => {
    const degraded = await run({ cache: memoryCache(null, "the cache path is a symlink") });
    expect(degraded.check.title).toContain("cache unavailable");
    expect(degraded.check.title).toContain("0.7.0");
  });
});

describe("updateCheck — the cache", () => {
  const hit: CacheEntry = {
    at: 1000, ok: true, tag: "v0.7.0", url: URL_OK, reason: null, retryAfterMs: null,
  };

  it("answers from a fresh entry without asking GitHub, and dates the row when it last asked", async () => {
    const r = await run({ cache: memoryCache(hit), fetch: never }, 1000 + SUCCESS_TTL_MS - 1);
    expect(r.self.latest).toBe("0.7.0");
    expect(r.check.checkedAt).toBe(1000);
  });

  it("re-asks once the success TTL has expired", async () => {
    const fetchFn = vi.fn<FetchFn>(
      body("v0.9.0", "https://github.com/neptunix/corral/releases/tag/v0.9.0"));
    const r = await run({ cache: memoryCache(hit), fetch: fetchFn }, 1000 + SUCCESS_TTL_MS);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(r.self.latest).toBe("0.9.0");
  });

  it("treats a clock that jumped backwards as a miss rather than pinning the entry", async () => {
    const fetchFn = vi.fn<FetchFn>(body("v0.7.0", URL_OK));
    await run({ cache: memoryCache(hit), fetch: fetchFn }, 500);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("caches a FAILURE too, so an outage does not spend the hourly budget every tick", async () => {
    const cache = memoryCache();
    const fetchFn = vi.fn<FetchFn>(() => Promise.reject(new Error("ENOTFOUND")));
    await updateCheck(io({ cache, fetch: fetchFn }), () => 1000);
    const second = await updateCheck(io({ cache, fetch: fetchFn }), () => 1000 + FAILURE_TTL_MS - 1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(second.check.state).toBe("n/a"); // the cached failure still names its reason
    expect(second.check.title).toMatch(/GitHub/);
    await updateCheck(io({ cache, fetch: fetchFn }), () => 1000 + FAILURE_TTL_MS);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("honours a clamped Retry-After as the backoff before re-asking", async () => {
    const cache = memoryCache();
    const fetchFn = vi.fn<FetchFn>(() =>
      Promise.resolve(new Response("", { status: 429, headers: { "retry-after": "1800" } })));
    await updateCheck(io({ cache, fetch: fetchFn }), () => 0);
    await updateCheck(io({ cache, fetch: fetchFn }), () => 1_799_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await updateCheck(io({ cache, fetch: fetchFn }), () => 1_800_001);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  /**
   * The live-header test below cannot reach this: `parseRetryAfter` clamps before the value is ever
   * stored, so the entry it writes already holds the cap and `fresh`'s own `Math.min` is a no-op.
   * A file written by another version — or a corrupted one — is the only way an unclamped backoff
   * arrives, and without the ceiling one would park the row at n/a for decades.
   */
  it("clamps a backoff that arrived from the cache FILE, not from a live header", async () => {
    const stale: CacheEntry = {
      at: 0, ok: false, tag: null, url: null,
      reason: "GitHub rate-limited the update check", retryAfterMs: 1e12,
    };
    const fetchFn = vi.fn<FetchFn>(body("v0.7.0", URL_OK));
    await updateCheck(io({ cache: memoryCache(stale), fetch: fetchFn }), () => 21_600_001);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("never lets an absurd Retry-After suppress the check beyond the cap", async () => {
    const cache = memoryCache();
    const fetchFn = vi.fn<FetchFn>(() =>
      Promise.resolve(new Response("", { status: 429, headers: { "retry-after": "999999999" } })));
    await updateCheck(io({ cache, fetch: fetchFn }), () => 0);
    await updateCheck(io({ cache, fetch: fetchFn }), () => 21_600_001);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("falls back to the default backoff when Retry-After is unparseable", async () => {
    const cache = memoryCache();
    const fetchFn = vi.fn<FetchFn>(() => Promise.resolve(
      new Response("", { status: 429, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } })));
    await updateCheck(io({ cache, fetch: fetchFn }), () => 0);
    await updateCheck(io({ cache, fetch: fetchFn }), () => FAILURE_TTL_MS - 1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("updateCheck — nothing in a check may throw", () => {
  it("survives a cache that throws on read", async () => {
    const hostile: UpdateCache = {
      read: () => { throw new Error("boom"); }, write: () => undefined, degraded: () => null,
    };
    const r = await run({ cache: hostile });
    expect(r.check.state).toBe("n/a");
    expect(r.check.id).toBe("update-check");
    expect(r.self).toEqual({ latest: null, releaseUrl: null });
  });

  it("survives a fetch that throws synchronously", async () => {
    expect((await run({ fetch: never })).check.state).toBe("n/a");
  });

  it("survives a repoSlug reader that throws", async () => {
    const r = await run({ repoSlug: () => { throw new Error("boom"); } });
    expect(r.check.state).toBe("n/a");
  });
});
