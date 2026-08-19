import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { CacheEntry } from "../server/diagnostics/update/cache.ts";
import { createUpdateCache } from "../server/diagnostics/update/cache.ts";

const SLUG = { owner: "neptunix", repo: "corral" };
const OTHER = { owner: "someone-else", repo: "corral" };

const entry = (over: Partial<CacheEntry> = {}): CacheEntry => ({
  at: 1000, ok: true, tag: "v0.7.0", reason: null, retryAfterMs: null, ...over,
});

const freshRoot = (): string => mkdtempSync(path.join(os.tmpdir(), "corral-cache-test-"));
const onlyFile = (dir: string): string => {
  const [file] = readdirSync(dir);
  expect(file).toBeDefined();
  return path.join(dir, file ?? "");
};

describe("createUpdateCache", () => {
  it("round-trips an entry through disk", () => {
    const dir = path.join(freshRoot(), "cache");
    const cache = createUpdateCache(dir);
    expect(cache.degraded()).toBe(null);
    expect(cache.read(SLUG)).toBe(null);
    cache.write(SLUG, entry());
    expect(createUpdateCache(dir).read(SLUG)).toEqual(entry());
  });

  it("writes mode 0600 into a 0700 directory", () => {
    const dir = path.join(freshRoot(), "cache");
    createUpdateCache(dir).write(SLUG, entry());
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(onlyFile(dir)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind", () => {
    const dir = path.join(freshRoot(), "cache");
    createUpdateCache(dir).write(SLUG, entry());
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("gives each repository its own file — a fork never reads the upstream's entry", () => {
    const dir = path.join(freshRoot(), "cache");
    const cache = createUpdateCache(dir);
    cache.write(SLUG, entry({ tag: "v1.0.0" }));
    cache.write(OTHER, entry({ tag: "v2.0.0" }));
    expect(readdirSync(dir)).toHaveLength(2);
    const reread = createUpdateCache(dir);
    expect(reread.read(SLUG)?.tag).toBe("v1.0.0");
    expect(reread.read(OTHER)?.tag).toBe("v2.0.0");
  });

  it("treats an unparseable file as a miss, never an exception", () => {
    const dir = path.join(freshRoot(), "cache");
    createUpdateCache(dir).write(SLUG, entry());
    writeFileSync(onlyFile(dir), "{ not json", "utf8");
    expect(createUpdateCache(dir).read(SLUG)).toBe(null);
  });

  it("treats a structurally wrong file as a miss", () => {
    const dir = path.join(freshRoot(), "cache");
    createUpdateCache(dir).write(SLUG, entry());
    writeFileSync(onlyFile(dir), JSON.stringify({ at: "soon" }), "utf8");
    expect(createUpdateCache(dir).read(SLUG)).toBe(null);
  });

  it("ignores a url left in an entry by an older build — the link is composed, not stored", () => {
    const dir = path.join(freshRoot(), "cache");
    createUpdateCache(dir).write(SLUG, entry());
    writeFileSync(onlyFile(dir), JSON.stringify({ ...entry(), url: "javascript:alert(1)" }), "utf8");
    const read = createUpdateCache(dir).read(SLUG);
    // The stale key is dropped rather than rejected, so an upgrade costs no extra request.
    expect(read?.tag).toBe("v0.7.0");
    expect(read).not.toHaveProperty("url");
  });

  it("refuses a symlinked cache directory, writing nothing through it", () => {
    const root = freshRoot();
    const real = path.join(root, "real");
    mkdirSync(real, { recursive: true });
    const link = path.join(root, "cache");
    symlinkSync(real, link);
    const cache = createUpdateCache(link);
    expect(cache.degraded()).toBe("the cache path is a symlink");
    cache.write(SLUG, entry());
    expect(cache.read(SLUG)).toEqual(entry()); // the in-memory TTL still answers
    expect(readdirSync(real)).toEqual([]);
  });

  it("refuses a group- or world-accessible directory", () => {
    const dir = path.join(freshRoot(), "cache");
    mkdirSync(dir, { recursive: true, mode: 0o777 });
    expect(createUpdateCache(dir).degraded()).toBe("the cache directory is group- or world-accessible");
  });

  it("refuses a path that is not a directory at all", () => {
    const root = freshRoot();
    const file = path.join(root, "not-a-dir");
    writeFileSync(file, "x", "utf8");
    expect(createUpdateCache(file).degraded()).not.toBe(null);
  });

  it("degrades to memory rather than retrying GitHub every launch", () => {
    const root = freshRoot();
    const file = path.join(root, "not-a-dir");
    writeFileSync(file, "x", "utf8");
    const cache = createUpdateCache(file);
    cache.write(SLUG, entry({ tag: "v9.9.9" }));
    expect(cache.read(SLUG)?.tag).toBe("v9.9.9");
  });

  /**
   * Every case above is caught by `vetDir` at construction, so `write` returns before it ever opens
   * a file — the branch that degrades on a write that FAILS LATER was never executed. It is the one
   * a read-only TMPDIR actually takes, and a version of it that swallowed the error without
   * recording a reason would send corral to GitHub on every launch while looking perfectly healthy.
   */
  // Skipped as root, where the directory mode is not enforced and the write would simply succeed.
  it.skipIf(process.getuid?.() === 0)(
    "degrades permanently when a WRITE fails, not only when the directory is bad up front", () => {
    const dir = path.join(freshRoot(), "cache");
    const cache = createUpdateCache(dir);
    expect(cache.degraded()).toBe(null);

    chmodSync(dir, 0o500);
    cache.write(SLUG, entry({ tag: "v9.9.9" }));
    chmodSync(dir, 0o700);

    expect(cache.degraded()).not.toBe(null);
    expect(readdirSync(dir)).toEqual([]);
    // Memory answers for the rest of the run, and a later write does not retry the disk.
    expect(cache.read(SLUG)?.tag).toBe("v9.9.9");
    cache.write(OTHER, entry({ tag: "v8.8.8" }));
    expect(readdirSync(dir)).toEqual([]);
    expect(cache.read(OTHER)?.tag).toBe("v8.8.8");
  },
  );
});
