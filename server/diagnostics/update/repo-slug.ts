import { readFileSync } from "node:fs";
import { z } from "zod";

import { PACKAGE_JSON_PATH } from "../../self-version.ts";

export interface RepoSlug {
  readonly owner: string;
  readonly repo: string;
}

// Both npm spellings: the object form this repo carries, and the string shorthand.
const RepositoryFieldSchema = z.union([
  z.string(),
  z.object({ url: z.string() }).transform((o) => o.url),
]);
const PackageSchema = z.object({ repository: RepositoryFieldSchema });

/** Owner and repo names GitHub actually allows. Also what keeps `..` out of the request path. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

function split(pathname: string): RepoSlug | null {
  const parts = pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (owner === undefined || repo === undefined) return null;
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return null;
  // SEGMENT admits a bare `.` and `..`, which are exactly the two that would escape the path.
  if ([owner, repo].some((s) => s === "." || s === "..")) return null;
  return { owner, repo };
}

/**
 * `<owner>/<repo>` from a `repository` field value, or null. Read from package.json rather than
 * hardcoded so a fork reports ITS OWN releases, never the upstream's — which is also why a
 * non-GitHub host yields null instead of a guess.
 */
export function parseRepoSlug(field: string): RepoSlug | null {
  const raw = field.trim();
  if (raw === "") return null;
  if (raw.includes("://")) {
    try {
      const url = new URL(raw.replace(/^git\+/, ""));
      return url.hostname === "github.com" ? split(url.pathname) : null;
    } catch {
      return null;
    }
  }
  // `git@github.com:owner/repo.git` — what `git clone git@…` leaves in a remote, and what a fork is
  // most likely to paste into `repository`. It carries no `://`, so the URL branch never sees it.
  const scp = /^(?:[^@\s]+@)?github\.com:(.+)$/.exec(raw);
  if (scp !== null) return split(`/${scp[1] ?? ""}`);
  // The bare shorthand means GitHub; any other `host:` prefix (`gitlab:o/r`) must not.
  const match = /^(?:github:)?([^:/\s]+\/[^:\s]+)$/.exec(raw);
  return match === null ? null : split(`/${match[1] ?? ""}`);
}

/**
 * This checkout's own slug, or null when package.json is unreadable or names no GitHub repository.
 * Never throws.
 */
export function readRepoSlug(
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): RepoSlug | null {
  try {
    const parsed = PackageSchema.safeParse(JSON.parse(readFile(PACKAGE_JSON_PATH)));
    return parsed.success ? parseRepoSlug(parsed.data.repository) : null;
  } catch {
    return null;
  }
}
