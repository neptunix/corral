import { AttentionMapSchema, type AttentionMap, type AttentionRecord, type PaneRead } from "@shared/schema";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { HerdrEnv } from "../environments.ts";
import { withMutex, writeAtomic } from "./atomic-store.ts";
import type { ReadFn } from "./herdr.ts";
import type { TransitionEvent } from "./transition.ts";

const SNAPSHOT_LINES = 60; // module const, colocated with its call site (§3.2)

export interface AttentionStore {
  init(): void;
  getMap(): AttentionMap;
  apply(env: HerdrEnv, events: readonly TransitionEvent[], clearedKeys: readonly string[]): void;
  pruneEnv(env: HerdrEnv, liveKeys: ReadonlySet<string>): void;
}

function frozenName(row: TransitionEvent["row"]): string | null {
  if (row.tab !== "" && row.tab !== "?") return row.tab;
  if (row.workspace !== "" && row.workspace !== "?") return row.workspace;
  return null;
}

export function createAttentionStore(opts: { dataDir: string; read: ReadFn }): AttentionStore {
  const filePath = path.join(opts.dataDir, "attention.json");
  const map = new Map<string, AttentionRecord>();
  const version = new Map<string, number>();

  function bump(key: string): number {
    const v = (version.get(key) ?? 0) + 1;
    version.set(key, v);
    return v;
  }

  function toObject(): AttentionMap {
    const out: AttentionMap = {};
    for (const [k, v] of map) out[k] = v;
    return out;
  }

  function persist(): void {
    const data = JSON.stringify(toObject());
    // Disk error must not break the poll loop, so swallow it (best-effort write-through, §3.2).
    void withMutex(filePath, () => { writeAtomic(filePath, data); }).catch(() => { /* ignore */ });
  }

  async function enrich(env: HerdrEnv, event: TransitionEvent, v: number): Promise<void> {
    const paneId = event.key.slice(event.key.indexOf(":") + 1);
    let read: PaneRead | null = null;
    try {
      read = await opts.read(env, paneId, SNAPSHOT_LINES);
    } catch {
      if (event.state === "finished") { // best-effort single retry (remote finish is the flaky case)
        try { read = await opts.read(env, paneId, SNAPSHOT_LINES); } catch { read = null; }
      }
    }
    if (read === null) return;              // keep captured:false
    if (version.get(event.key) !== v) return; // stale — cleared/re-detected since detection: no-op
    const current = map.get(event.key);
    if (current === undefined) return;
    map.set(event.key, { ...current, lastLines: read.text, captured: true });
    // This persist() is disk-only, so the enriched lastLines preview reaches the browser only on the
    // NEXT poll push (up to ~30s) — a card can briefly say "no output captured" after capture actually
    // succeeded. A real fix would need an onChange hook the poller subscribes to; for now this is a
    // deliberate "durable, not instant" tradeoff.
    persist();
  }

  return {
    init() {
      if (!existsSync(filePath)) return;
      try {
        const parsed = AttentionMapSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
        for (const [k, v] of Object.entries(parsed)) { map.set(k, v); version.set(k, 1); }
      } catch { /* corrupt file → start empty */ }
    },
    getMap: toObject,
    apply(env, events, clearedKeys) {
      if (events.length === 0 && clearedKeys.length === 0) return; // no change — don't rewrite attention.json every poll
      for (const key of clearedKeys) { map.delete(key); bump(key); }
      for (const event of events) {
        const record: AttentionRecord = {
          state: event.state, since: event.since, sessionName: frozenName(event.row), lastLines: "", captured: false,
        };
        map.set(event.key, record);
        const v = bump(event.key);
        void enrich(env, event, v);
      }
      persist();
    },
    pruneEnv(env, liveKeys) {
      const prefix = `${env.id}:`;
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix) && !liveKeys.has(key)) { map.delete(key); bump(key); }
      }
      persist();
    },
  };
}
