import { describe, expect, it, vi } from "vitest";

import type { FetchFn } from "../server/diagnostics/update/github.ts";
import { MAX_BODY_BYTES, fetchLatestRelease, parseRetryAfter } from "../server/diagnostics/update/github.ts";

const SLUG = { owner: "neptunix", repo: "corral" };
const LIMITS = { retryMinMs: 900_000, retryMaxMs: 21_600_000, timeoutMs: 8_000 };
const RELEASE = { tag_name: "v0.7.0", html_url: "https://github.com/neptunix/corral/releases/tag/v0.7.0" };

const respond = (body: string, init?: ResponseInit): FetchFn => () =>
  Promise.resolve(new Response(body, init));

describe("parseRetryAfter", () => {
  it("reads delta-seconds and clamps into the window", () => {
    expect(parseRetryAfter("60", 900_000, 21_600_000)).toBe(900_000);
    expect(parseRetryAfter("1800", 900_000, 21_600_000)).toBe(1_800_000);
    expect(parseRetryAfter("999999999", 900_000, 21_600_000)).toBe(21_600_000);
  });

  it("ignores the HTTP-date form and anything unparseable, falling back to the default backoff", () => {
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", 1, 2)).toBe(null);
    expect(parseRetryAfter("120abc", 1, 2)).toBe(null);
    expect(parseRetryAfter("-5", 1, 2)).toBe(null);
    expect(parseRetryAfter("", 1, 2)).toBe(null);
    expect(parseRetryAfter(null, 1, 2)).toBe(null);
  });
});

describe("fetchLatestRelease", () => {
  it("asks the releases/latest endpoint with a User-Agent and no automatic redirect", async () => {
    const fetchFn = vi.fn<FetchFn>(() => Promise.resolve(new Response(JSON.stringify(RELEASE))));
    const res = await fetchLatestRelease(fetchFn, SLUG, LIMITS);
    expect(res).toEqual({ kind: "release", tag: "v0.7.0", url: RELEASE.html_url });
    const call = fetchFn.mock.calls[0];
    expect(call?.[0]).toBe("https://api.github.com/repos/neptunix/corral/releases/latest");
    expect(call?.[1].redirect).toBe("manual");
    expect(new Headers(call?.[1].headers).get("user-agent")).not.toBe(null);
  });

  it("reports a rate limit from 429", async () => {
    const res = await fetchLatestRelease(
      respond("", { status: 429, headers: { "retry-after": "1800" } }), SLUG, LIMITS);
    expect(res).toEqual({ kind: "rate-limited", retryAfterMs: 1_800_000 });
  });

  it("reports a rate limit from 403 with an exhausted budget, but a plain 403 as a status", async () => {
    const limited = await fetchLatestRelease(
      respond("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }), SLUG, LIMITS);
    expect(limited).toEqual({ kind: "rate-limited", retryAfterMs: null });
    expect(await fetchLatestRelease(respond("", { status: 403 }), SLUG, LIMITS))
      .toEqual({ kind: "status", status: 403 });
  });

  it("never follows a redirect", async () => {
    const res = await fetchLatestRelease(
      respond("", { status: 302, headers: { location: "https://evil.example/r" } }), SLUG, LIMITS);
    expect(res).toEqual({ kind: "redirect", status: 302 });
  });

  it("reports a non-200 as a status", async () => {
    expect(await fetchLatestRelease(respond("", { status: 404 }), SLUG, LIMITS))
      .toEqual({ kind: "status", status: 404 });
  });

  it("abandons an oversized body instead of buffering it", async () => {
    const big = JSON.stringify({ ...RELEASE, pad: "x".repeat(MAX_BODY_BYTES + 1) });
    expect(await fetchLatestRelease(respond(big), SLUG, LIMITS)).toEqual({ kind: "too-large" });
  });

  it("reports a malformed body, whether it is not JSON or not a release", async () => {
    expect(await fetchLatestRelease(respond("{ not json"), SLUG, LIMITS)).toEqual({ kind: "malformed" });
    expect(await fetchLatestRelease(respond(JSON.stringify({ tag_name: 7 })), SLUG, LIMITS))
      .toEqual({ kind: "malformed" });
  });

  it("reports a transport failure rather than rejecting", async () => {
    const res = await fetchLatestRelease(
      () => Promise.reject(new Error("getaddrinfo ENOTFOUND api.github.com")), SLUG, LIMITS);
    expect(res.kind).toBe("unreachable");
    expect(res.kind === "unreachable" && res.message).toContain("ENOTFOUND");
  });

  it("aborts on the deadline and calls that a timeout, not an unreachable host", async () => {
    const res = await fetchLatestRelease((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => { reject(new Error("The operation was aborted")); });
    }), SLUG, { ...LIMITS, timeoutMs: 20 });
    expect(res).toEqual({ kind: "timeout" });
  });

  it("holds the deadline over the BODY too, not only the headers", async () => {
    const stalled: FetchFn = (_url, init) => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"tag_name":'));
        init.signal?.addEventListener("abort", () => { controller.error(new Error("aborted")); });
      },
    })));
    expect(await fetchLatestRelease(stalled, SLUG, { ...LIMITS, timeoutMs: 20 })).toEqual({ kind: "timeout" });
  });
});
