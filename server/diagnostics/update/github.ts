import { z } from "zod";

import type { RepoSlug } from "./repo-slug.ts";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type ReleaseFetch =
  | { readonly kind: "release"; readonly tag: string }
  | { readonly kind: "rate-limited"; readonly retryAfterMs: number | null }
  | { readonly kind: "redirect"; readonly status: number }
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "too-large" }
  | { readonly kind: "malformed" }
  | { readonly kind: "timeout" }
  | { readonly kind: "unreachable"; readonly message: string };

/** A release payload is a few KB; the cap is what stops a slow-drip body a socket timeout would miss. */
export const MAX_BODY_BYTES = 262_144;
/**
 * Covers the WHOLE response, not just the headers — the signal aborts the body stream too. Passed in
 * by the producer rather than read here, so a test can exercise the deadline without waiting it out.
 */
export const REQUEST_TIMEOUT_MS = 8_000;

const USER_AGENT = "corral-self-diagnostics";

// The ONLY field used. `html_url` is deliberately not read: the link corral renders is composed
// from its own validated slug and tag, so no string GitHub sends ever reaches an `href`.
const ReleaseSchema = z.object({ tag_name: z.string() });

/**
 * Delta-seconds only — the HTTP-date form is ignored — and clamped. Every other external input here
 * is bounded, and an unbounded one would let the far side set corral's schedule, persisted past the
 * process that received it.
 */
export function parseRetryAfter(header: string | null, minMs: number, maxMs: number): number | null {
  if (header === null) return null;
  const raw = header.trim();
  if (!/^\d{1,9}$/.test(raw)) return null;
  return Math.min(Math.max(Number.parseInt(raw, 10) * 1000, minMs), maxMs);
}

/** Reads the body a chunk at a time and abandons it past the cap, rather than buffering it whole. */
async function readCapped(res: Response, cap: number): Promise<string | null> {
  const body = res.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    const value = result.value;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * One request for `<owner>/<repo>`'s latest release. Total: every failure is a `ReleaseFetch` value,
 * never a rejection.
 */
export async function fetchLatestRelease(
  fetchFn: FetchFn,
  slug: RepoSlug,
  opts: { readonly retryMinMs: number; readonly retryMaxMs: number; readonly timeoutMs: number },
): Promise<ReleaseFetch> {
  const url = `https://api.github.com/repos/${slug.owner}/${slug.repo}/releases/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, opts.timeoutMs);
  try {
    const res = await fetchFn(url, {
      // GitHub rejects a request with no User-Agent outright. `manual` because this endpoint has no
      // legitimate cross-host redirect, and following one silently is how an intercepted endpoint
      // reaches further than the single host this check is willing to talk to.
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
      redirect: "manual",
      signal: controller.signal,
    });
    const retryAfter = res.headers.get("retry-after");
    // GitHub answers 403 for an exhausted unauthenticated budget as well as for a plain refusal;
    // only the budget case is a rate limit, and only it deserves the longer backoff.
    if (res.status === 429
      || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || retryAfter !== null))) {
      return {
        kind: "rate-limited",
        retryAfterMs: parseRetryAfter(retryAfter, opts.retryMinMs, opts.retryMaxMs),
      };
    }
    if (res.status >= 300 && res.status < 400) return { kind: "redirect", status: res.status };
    if (res.status !== 200) return { kind: "status", status: res.status };
    const body = await readCapped(res, MAX_BODY_BYTES);
    if (body === null) return { kind: "too-large" };
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { kind: "malformed" };
    }
    const parsed = ReleaseSchema.safeParse(json);
    if (!parsed.success) return { kind: "malformed" };
    return { kind: "release", tag: parsed.data.tag_name };
  } catch (err) {
    if (controller.signal.aborted) return { kind: "timeout" };
    return { kind: "unreachable", message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
