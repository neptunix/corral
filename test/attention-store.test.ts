import { type PaneRead, type SessionRow } from "@shared/schema";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { createAttentionStore } from "../server/attention-store.ts";
import type { TransitionEvent } from "../server/transition.ts";

const env: HerdrEnv = { id: "e", label: "E", kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {} };
const row = (p: string, status: string): SessionRow => ({
  env: "e", paneId: p, status, agent: "claude", cwd: "/x", tab: "fs-" + p, workspace: "w",
  sessionId: null, recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null,
});
const ev = (p: string, state: "blocked" | "finished"): TransitionEvent => ({ key: `e:${p}`, state, since: 100, row: row(p, state === "blocked" ? "blocked" : "done") });
const mkdir = () => mkdtempSync(path.join(tmpdir(), "att-"));
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("attention-store", () => {
  it("inserts synchronously with frozen SessionRow name, captured:false, then enriches", async () => {
    const read = vi.fn().mockResolvedValue({ text: "tail-out", ctxPct: null, model: null, sessionName: "IGNORED" });
    const s = createAttentionStore({ dataDir: mkdir(), read });
    s.apply(env, [ev("1", "blocked")], []);
    expect(s.getMap()["e:1"]).toMatchObject({ state: "blocked", sessionName: "fs-1", lastLines: "", captured: false });
    await flush();
    expect(s.getMap()["e:1"]).toMatchObject({ lastLines: "tail-out", captured: true });
  });

  it("freshness guard: enrichment for a since-cleared key is a no-op (resurrection race)", async () => {
    let resolveRead!: (v: unknown) => void;
    const read = vi.fn().mockReturnValue(new Promise((r) => { resolveRead = r; }));
    const s = createAttentionStore({ dataDir: mkdir(), read });
    s.apply(env, [ev("1", "finished")], []);   // insert, enrichment pending
    s.apply(env, [], ["e:1"]);                  // cleared before the read resolves
    expect(s.getMap()["e:1"]).toBeUndefined();
    resolveRead({ text: "late", ctxPct: null, model: null, sessionName: null });
    await flush();
    expect(s.getMap()["e:1"]).toBeUndefined();  // NOT resurrected
  });

  it("freshness guard: a stale enrichment from a superseded detection does not overwrite the newer record", async () => {
    // Isolates the version check (not the cleared short-circuit): the key is re-inserted, so `current`
    // is DEFINED when the stale read resolves — only `version.get(key) !== v` prevents the clobber.
    const resolvers: ((v: PaneRead) => void)[] = [];
    const read = vi.fn().mockImplementation(() => new Promise<PaneRead>((r) => { resolvers.push(r); }));
    const s = createAttentionStore({ dataDir: mkdir(), read });
    s.apply(env, [ev("1", "finished")], []);   // record v1, enrichment #0 pending
    s.apply(env, [], ["e:1"]);                  // clear (version bumps)
    s.apply(env, [ev("1", "blocked")], []);     // record v3, enrichment #1 pending
    resolvers[1]?.({ text: "fresh", ctxPct: null, model: null, sessionName: null }); // newest resolves first
    await flush();
    expect(s.getMap()["e:1"]).toMatchObject({ state: "blocked", lastLines: "fresh", captured: true });
    resolvers[0]?.({ text: "STALE", ctxPct: null, model: null, sessionName: null });  // stale resolves late
    await flush();
    expect(s.getMap()["e:1"]).toMatchObject({ lastLines: "fresh" }); // version guard: NOT overwritten
  });

  it("captured:false stays on read failure", async () => {
    const read = vi.fn().mockRejectedValue(new Error("boom"));
    const s = createAttentionStore({ dataDir: mkdir(), read });
    s.apply(env, [ev("1", "blocked")], []);
    await flush();
    expect(s.getMap()["e:1"]).toMatchObject({ captured: false, lastLines: "" });
  });

  it("finish path retries the read once (best-effort)", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("slow"))
      .mockResolvedValueOnce({ text: "second", ctxPct: null, model: null, sessionName: null });
    const s = createAttentionStore({ dataDir: mkdir(), read });
    s.apply(env, [ev("1", "finished")], []);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(s.getMap()["e:1"]).toMatchObject({ captured: true, lastLines: "second" });
  });

  it("writes through to attention.json and reloads via init()", async () => {
    const dir = mkdir();
    const read = vi.fn().mockResolvedValue({ text: "x", ctxPct: null, model: null, sessionName: null });
    const s1 = createAttentionStore({ dataDir: dir, read });
    s1.apply(env, [ev("1", "blocked")], []);
    await flush();
    expect(existsSync(path.join(dir, "attention.json"))).toBe(true);
    const s2 = createAttentionStore({ dataDir: dir, read });
    s2.init();
    expect(s2.getMap()["e:1"]).toMatchObject({ state: "blocked" });
  });

  it("a no-op apply (no events, no cleared keys) does not touch attention.json", async () => {
    // The poller calls apply() every ~30s cycle; an unconditional persist would
    // rewrite the file (temp+rename) thousands of times a day with identical content.
    const dir = mkdir();
    const read = vi.fn().mockResolvedValue({ text: "x", ctxPct: null, model: null, sessionName: null });
    const s = createAttentionStore({ dataDir: dir, read });
    s.apply(env, [], []);
    await flush();
    expect(existsSync(path.join(dir, "attention.json"))).toBe(false);
  });

  it("init() survives a corrupt attention.json (not JSON) and starts empty", () => {
    const dir = mkdir();
    writeFileSync(path.join(dir, "attention.json"), "{ not json");
    const read = vi.fn();
    const s = createAttentionStore({ dataDir: dir, read });
    expect(() => { s.init(); }).not.toThrow();
    expect(s.getMap()).toEqual({});
  });

  it("init() survives a schema-invalid attention.json and starts empty", () => {
    const dir = mkdir();
    writeFileSync(path.join(dir, "attention.json"), JSON.stringify({ "e:1": { state: "weird", nope: true } }));
    const read = vi.fn();
    const s = createAttentionStore({ dataDir: dir, read });
    expect(() => { s.init(); }).not.toThrow();
    expect(s.getMap()).toEqual({});
  });

  it("pruneEnv drops this env's orphans but keeps another env's records", () => {
    const read = vi.fn().mockResolvedValue({ text: "x", ctxPct: null, model: null, sessionName: null });
    const s = createAttentionStore({ dataDir: mkdir(), read });
    s.apply(env, [ev("1", "blocked")], []);
    s.apply({ id: "other", label: "O", kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {} }, [{ ...ev("9", "blocked"), key: "other:9" }], []);
    s.pruneEnv(env, new Set<string>()); // e:1 has no live key → prune; other:9 untouched
    expect(s.getMap()["e:1"]).toBeUndefined();
    expect(s.getMap()["other:9"]).toBeDefined();
  });
});
