import type { Check, CheckState, SelfInfo } from "@shared/diagnostics-schema";
import { checkKey, isStableTag } from "@shared/diagnostics-schema";

import type { CacheEntry, UpdateCache } from "./cache.ts";
import type { FetchFn, ReleaseFetch } from "./github.ts";
import { REQUEST_TIMEOUT_MS, fetchLatestRelease } from "./github.ts";
import type { RepoSlug } from "./repo-slug.ts";
import { compareSemver } from "../env.ts";

export const SUCCESS_TTL_MS = 21_600_000;  // 6 h
/** A GitHub outage must not turn every 60-second tick into a request against a 60/hour budget. */
export const FAILURE_TTL_MS = 900_000;     // 15 min
/** Ceiling on anything the far side asks for, `Retry-After` included. */
export const RETRY_MAX_MS = 21_600_000;    // 6 h

const SCOPE = { kind: "global" as const };
const DOC = { anchor: "upgrading", title: "Upgrading" };

/**
 * All of the producer's I/O, injected. `enumerateChecks` passes a stub that performs no request and
 * reports the check as disabled — without that seam the row could not be registered (and its README
 * anchor could not be guarded) without `npm run check` calling api.github.com on every run.
 */
export interface UpdateCheckIo {
  readonly enabled: boolean;
  readonly version: string | null;
  readonly repoSlug: () => RepoSlug | null;
  readonly fetch: FetchFn;
  readonly cache: UpdateCache;
}

export interface UpdateCheckResult {
  readonly check: Check;
  readonly self: Pick<SelfInfo, "latest" | "releaseUrl">;
}

function make(at: number, state: CheckState, title: string, detail: string): Check {
  return {
    id: "update-check", key: checkKey("update-check", SCOPE), scope: SCOPE,
    title, state,
    // `fatal` and `warning` never occur here. A failed update check is not a problem with the
    // operator's install, and an available update lights the muted dot, never the badge digit.
    severity: "info",
    detail, doc: DOC, class: "network", checkedAt: at,
    startupOkLine: false, haltsStartup: false,
  };
}

/** The panel renders only `title` for a folded row, so every n/a reason has to be legible there. */
const tail = (io: UpdateCheckIo): string => {
  const why = io.cache.degraded();
  return why === null ? "" : ` (cache unavailable: ${why})`;
};

const na = (at: number, title: string, io: UpdateCheckIo): UpdateCheckResult =>
  ({ check: make(at, "n/a", `${title}${tail(io)}`, ""), self: { latest: null, releaseUrl: null } });

/**
 * The releases INDEX, anchored at this release. Not the single-release page: an operator several
 * versions behind needs every release between their build and the latest one, and the index is the
 * page that shows them all. `#release-<tag>` is GitHub's own anchor on that page, and the latest
 * release is always its first entry, so the anchor always resolves.
 *
 * COMPOSED, never taken from the response. `html_url` is not read at all, so there is no
 * attacker-influenced string to validate: `owner` and `repo` already passed repo-slug's
 * `[A-Za-z0-9._-]+` rule and `tag` passed `isStableTag`, so every part of this URL is constrained.
 */
function releaseIndexUrl(slug: RepoSlug, tag: string): string {
  return `https://github.com/${slug.owner}/${slug.repo}/releases#release-${tag}`;
}

function reasonFor(res: ReleaseFetch): string {
  switch (res.kind) {
    case "release":
      return "";
    case "rate-limited":
      return res.retryAfterMs === null
        ? "GitHub rate-limited the update check"
        : `GitHub rate-limited the update check — retrying in ~${String(Math.round(res.retryAfterMs / 60_000))} min`;
    case "redirect":
      return `GitHub redirected the update check (HTTP ${String(res.status)}) — not followed`;
    case "status":
      return `GitHub answered HTTP ${String(res.status)} to the update check`;
    case "too-large":
      return "GitHub's release response was larger than the update check accepts";
    case "malformed":
      return "GitHub's release response did not parse";
    case "timeout":
      return "the update check timed out reaching GitHub";
    case "unreachable":
      return `the update check could not reach GitHub (${res.message.slice(0, 80)})`;
  }
}

function toEntry(res: ReleaseFetch, at: number): CacheEntry {
  if (res.kind === "release") {
    return { at, ok: true, tag: res.tag, reason: null, retryAfterMs: null };
  }
  return {
    at, ok: false, tag: null, reason: reasonFor(res),
    retryAfterMs: res.kind === "rate-limited" ? res.retryAfterMs : null,
  };
}

/** A negative age means the clock jumped backwards; treat that as a miss rather than pinning the entry. */
function fresh(entry: CacheEntry, at: number): boolean {
  const ttl = entry.ok
    ? SUCCESS_TTL_MS
    : Math.min(Math.max(entry.retryAfterMs ?? FAILURE_TTL_MS, FAILURE_TTL_MS), RETRY_MAX_MS);
  const age = at - entry.at;
  return age >= 0 && age < ttl;
}

function verdict(entry: CacheEntry, version: string, slug: RepoSlug, io: UpdateCheckIo): UpdateCheckResult {
  // The entry's own timestamp, not `now`: this is when corral actually spoke to GitHub, which is what
  // the panel's age line should reflect for a row answered from a six-hour-old cache.
  const at = entry.at;
  if (!entry.ok) return na(at, entry.reason ?? "the update check did not complete", io);
  const tag = entry.tag;
  // Guarded BEFORE the comparison, not inside it: `compareSemver` drops a prerelease suffix and
  // coerces a non-numeric segment to zero, so `0.8.0-rc.1` would read as equal to `0.8.0` and
  // `release-2026` as older than everything.
  if (tag === null || !isStableTag(tag)) {
    return na(at, "GitHub's latest release is not a plain version tag", io);
  }
  const latest = tag.replace(/^v/, "");
  // `latest` is written ONLY when the release is strictly newer: the panel renders its update plate
  // on `latest !== null` with no comparison of its own, so writing it every time would announce an
  // update to an operator already running it.
  if (compareSemver(latest, version) <= 0) {
    return {
      check: make(at, "ok", `corral ${version} is the latest release${tail(io)}`, ""),
      self: { latest: null, releaseUrl: null },
    };
  }
  return {
    check: make(at, "problem", `corral ${latest} is available — this build is ${version}${tail(io)}`,
      "Pull and reinstall to upgrade — see the README's Upgrading section."),
    self: { latest, releaseUrl: releaseIndexUrl(slug, tag) },
  };
}

async function run(io: UpdateCheckIo, now: () => number): Promise<UpdateCheckResult> {
  const at = now();
  if (!io.enabled) return na(at, "the update check is off (UPDATE_CHECK_ENABLED=false)", io);
  const version = io.version;
  // A null running version is reachable, not hypothetical — a checkout with no `version` field has
  // one. The natural patch (`compareSemver(version ?? "0.0.0", tag)`) would announce an update forever.
  if (version === null || !isStableTag(version)) {
    return na(at, "the update check cannot tell which version this build is", io);
  }
  const slug = io.repoSlug();
  if (slug === null) return na(at, "the update check found no GitHub repository in package.json", io);
  const held = io.cache.read(slug);
  if (held !== null && fresh(held, at)) return verdict(held, version, slug, io);
  const fetched = await fetchLatestRelease(io.fetch, slug, {
    retryMinMs: FAILURE_TTL_MS, retryMaxMs: RETRY_MAX_MS, timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const entry = toEntry(fetched, at);
  // Failures are cached too, or a GitHub outage spends the hourly budget one tick at a time and
  // leaves the row stuck at n/a by corral's own doing.
  io.cache.write(slug, entry);
  return verdict(entry, version, slug, io);
}

/**
 * One `network`-class row plus the `SelfInfo` fields it feeds. Total by construction: the store must
 * never hold a value this function did not validate, and the sweep must never die because GitHub did.
 */
export async function updateCheck(io: UpdateCheckIo, now: () => number): Promise<UpdateCheckResult> {
  try {
    return await run(io, now);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      check: make(now(), "n/a", `the update check failed unexpectedly (${msg.slice(0, 80)})`, ""),
      self: { latest: null, releaseUrl: null },
    };
  }
}
