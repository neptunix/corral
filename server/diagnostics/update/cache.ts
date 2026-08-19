import { createHash, randomBytes } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import type { RepoSlug } from "./repo-slug.ts";

/**
 * NOT under `$CORRAL_HOME`: `BOARD_DATA_DIR` defaults to it and `server/git.ts` runs `git add -A`
 * over that tree every 10 s, so the cache would be committed into the operator's board-data
 * repository forever. `config.ts` records that this trap has already fired once for real, which is
 * why `BRIEF_ROOT` and `UPLOAD_ROOT` live here too. Per-uid, so two accounts on one box never share.
 */
export const CACHE_DIR = path.join(os.tmpdir(), `corral-update-check-${String(process.getuid?.() ?? 0)}`);

export const CacheEntrySchema = z.object({
  at: z.number(),
  ok: z.boolean(),
  tag: z.string().nullable(),
  reason: z.string().nullable(),
  retryAfterMs: z.number().nullable(),
});
export type CacheEntry = z.infer<typeof CacheEntrySchema>;

export interface UpdateCache {
  read: (slug: RepoSlug) => CacheEntry | null;
  write: (slug: RepoSlug, entry: CacheEntry) => void;
  /** null while the disk cache is usable; a short reason once this run degraded to memory. */
  degraded: () => string | null;
}

const key = (slug: RepoSlug): string => `${slug.owner}/${slug.repo}`;

/**
 * Hashed per repository: this repo is developed out of several worktrees, and a fork must never be
 * handed the upstream's cached release — the exact isolation the `repository` parsing exists for.
 */
function entryPath(dir: string, slug: RepoSlug): string {
  return path.join(dir, `${createHash("sha256").update(key(slug)).digest("hex").slice(0, 32)}.json`);
}

/**
 * Creates the directory and vets what is actually there. `mkdir(recursive)` succeeds silently
 * against a pre-existing directory or symlink someone else owns, so the `lstat` is the real check —
 * and it is an `lstat`, not a `stat`, so a planted symlink is seen rather than followed.
 */
function vetDir(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) return "the cache path is a symlink";
    if (!st.isDirectory()) return "the cache path is not a directory";
    if (st.uid !== (process.getuid?.() ?? st.uid)) return "the cache directory belongs to another user";
    if ((st.mode & 0o077) !== 0) return "the cache directory is group- or world-accessible";
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * `wx` — fail if the path exists, and never follow a symlink planted there. `writeAtomic`
 * (server/atomic-store.ts) is deliberately NOT used: it writes a predictable `${file}.tmp` with
 * neither guard. `brief.ts` gets away with that because its filename is a `nanoid`, so its `.tmp`
 * sibling is unguessable too; a cache path has to be findable again after a restart, so it cannot be.
 */
function writeEntry(file: string, entry: CacheEntry): void {
  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(entry));
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * The disk cache, with an in-memory fallback for this process's lifetime. A failed write degrades
 * PERMANENTLY rather than being retried: otherwise a read-only TMPDIR would send corral to GitHub on
 * every launch, and the trade the disk cache exists to make is surviving a restart, not a reboot.
 */
export function createUpdateCache(dir: string = CACHE_DIR): UpdateCache {
  let reason = vetDir(dir);
  const memory = new Map<string, CacheEntry>();
  return {
    read(slug) {
      if (reason !== null) return memory.get(key(slug)) ?? null;
      try {
        const parsed = CacheEntrySchema.safeParse(JSON.parse(readFileSync(entryPath(dir, slug), "utf8")));
        // A missing, unreadable or unparseable file is a MISS. Never an exception: this runs inside a
        // check, and nothing in a check may throw.
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    write(slug, entry) {
      memory.set(key(slug), entry);
      if (reason !== null) return;
      try {
        writeEntry(entryPath(dir, slug), entry);
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
    },
    degraded: () => reason,
  };
}
