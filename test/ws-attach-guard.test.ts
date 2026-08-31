import { describe, expect, it } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { TERM_DIM_MAX } from "../server/pty-bridge.ts";
import { createSpawnLimiter, PANE_RE, validateUpgrade } from "../server/ws-attach-guard.ts";

const envs: HerdrEnv[] = [{ id: "work-local", label: "Work", kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {} }];
const ORIGINS = ["http://127.0.0.1:8787", "http://localhost:8787"];
const H = (origin?: string): { origin?: string } => (origin === undefined ? {} : { origin });
const allowed = "http://127.0.0.1:8787";
const okUrl = "/api/sessions/work-local/w1-1/attach";

describe("validateUpgrade", () => {
  it("accepts a well-formed attach upgrade", () => {
    const r = validateUpgrade("/api/sessions/work-local/w653-1/attach", H("http://127.0.0.1:8787"), envs, ORIGINS);
    expect(r).toEqual({ ok: true, env: envs[0], paneId: "w653-1" });
  });
  it("accepts the localhost origin variant too", () => {
    const r = validateUpgrade("/api/sessions/work-local/w1-1/attach", H("http://localhost:8787"), envs, ORIGINS);
    expect(r).toMatchObject({ ok: true, paneId: "w1-1" });
  });
  it("ignores a query string on the attach path", () => {
    const r = validateUpgrade("/api/sessions/work-local/w1-1/attach?x=1", H("http://localhost:8787"), envs, ORIGINS);
    expect(r).toMatchObject({ ok: true, paneId: "w1-1" });
  });
  it("rejects a non-attach path", () => {
    expect(validateUpgrade("/api/stream", H("http://127.0.0.1:8787"), envs, ORIGINS)).toMatchObject({ ok: false, status: 404 });
  });
  it("rejects an absent Origin (fail closed)", () => {
    expect(validateUpgrade("/api/sessions/work-local/p/attach", H(undefined), envs, ORIGINS)).toMatchObject({ ok: false, status: 403 });
  });
  it("rejects a disallowed Origin", () => {
    expect(validateUpgrade("/api/sessions/work-local/p/attach", H("https://evil.example"), envs, ORIGINS)).toMatchObject({ ok: false, status: 403 });
  });
  it("rejects an unknown env", () => {
    expect(validateUpgrade("/api/sessions/nope/p/attach", H("http://localhost:8787"), envs, ORIGINS)).toMatchObject({ ok: false, status: 400 });
  });
  it("rejects a PANE_RE-invalid paneId (a dot)", () => {
    expect(validateUpgrade("/api/sessions/work-local/p.1/attach", H("http://localhost:8787"), envs, ORIGINS)).toMatchObject({ ok: false, status: 400 });
  });
  it("rejects a leading-dash paneId — SEC-4 primary control now that the `--` argv guard is dropped (Task 0)", () => {
    // With no `--` in buildAttachSpec (herdr 0.7.1 rejects it), the alnum-leading PANE_RE anchor is the
    // load-bearing option-injection defense. Task 0 confirmed real ids are alphanumeric-leading, so this
    // never rejects a valid target. A `-danger` paneId would otherwise reach `agent attach -danger` bare.
    expect(validateUpgrade("/api/sessions/work-local/-danger/attach", H("http://localhost:8787"), envs, ORIGINS)).toMatchObject({ ok: false, status: 400 });
  });
  it("PANE_RE admits real ids and rejects leading dash / dot / leading colon", () => {
    expect(PANE_RE.test("w653abc:p1")).toBe(true);
    expect(PANE_RE.test("w1-1")).toBe(true);
    expect(PANE_RE.test("-danger")).toBe(false);
    expect(PANE_RE.test("p.1")).toBe(false);
    expect(PANE_RE.test(":lead")).toBe(false);
    expect(PANE_RE.test("")).toBe(false);
  });

  it("parses a valid size from the query", () => {
    const r = validateUpgrade(`${okUrl}?cols=188&rows=45`, { origin: allowed }, envs, ORIGINS);
    expect(r.ok && r.size).toEqual({ cols: 188, rows: 45 });
  });

  it.each([
    ["no query", ""],
    ["missing rows", "?cols=188"],
    ["non-numeric", "?cols=wide&rows=45"],
    ["zero", "?cols=0&rows=45"],
    ["negative", "?cols=-80&rows=45"],
    ["fractional", "?cols=188.5&rows=45"],
    ["above max", `?cols=${String(TERM_DIM_MAX + 1)}&rows=45`],
    ["below the floor", "?cols=80&rows=24"],
    ["malformed escape", "?cols=%E0%A4%A&rows=45"],
  ])("reads %s as no size given", (_label, query) => {
    const r = validateUpgrade(`${okUrl}${query}`, { origin: allowed }, envs, ORIGINS);
    expect(r.ok).toBe(true);
    expect(r.ok && r.size).toBeUndefined();
  });

  it("does not parse the query when the origin is rejected", () => {
    const r = validateUpgrade(`${okUrl}?cols=188&rows=45`, { origin: "http://evil.test" }, envs, ORIGINS);
    expect(r).toEqual({ ok: false, status: 403, reason: "origin not allowed" });
  });
});

describe("createSpawnLimiter", () => {
  it("enforces the concurrent cap and releases slots", () => {
    const t = 0;
    const lim = createSpawnLimiter({ maxConcurrent: 2, ratePerWindow: 100, windowMs: 1000, now: () => t });
    expect(lim.tryReserve()).toBe(true);
    expect(lim.tryReserve()).toBe(true);
    expect(lim.tryReserve()).toBe(false); // cap
    lim.release();
    expect(lim.tryReserve()).toBe(true);
  });
  it("enforces the rate window independent of the cap", () => {
    let t = 0;
    const lim = createSpawnLimiter({ maxConcurrent: 100, ratePerWindow: 2, windowMs: 1000, now: () => t });
    expect(lim.tryReserve()).toBe(true);
    lim.release();
    expect(lim.tryReserve()).toBe(true);
    lim.release();
    expect(lim.tryReserve()).toBe(false); // rate exhausted even though the cap is free
    t = 1001;
    expect(lim.tryReserve()).toBe(true); // window rolled
  });
  it("release never drives active below zero (over-release is inert)", () => {
    const t = 0;
    const lim = createSpawnLimiter({ maxConcurrent: 1, ratePerWindow: 100, windowMs: 1000, now: () => t });
    lim.release(); // over-release with nothing active
    expect(lim.tryReserve()).toBe(true);
    expect(lim.tryReserve()).toBe(false); // still capped at 1 — the stray release did not add a slot
  });
});
