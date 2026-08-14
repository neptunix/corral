import type { RecapSource, RecapStatus } from "@shared/schema";

export interface CacheEntry {
  readonly sessionId: string;
  readonly recap: string;
  readonly at: number;
  readonly status: RecapStatus;
  // Which ladder rung produced `recap` — travels WITH the text, so a failed read that keeps the last
  // good recap keeps the label that describes it too.
  readonly source: RecapSource | null;
}

export interface RecapCache {
  update(key: string, sessionId: string, recap: string | null, status: RecapStatus, source: RecapSource | null): void;
  get(key: string): CacheEntry | null;
  prune(liveKeys: ReadonlySet<string>): void;
}

export function createRecapCache(): RecapCache {
  const store = new Map<string, CacheEntry>();

  return {
    update(key, sessionId, recap, status, source) {
      const existing = store.get(key);
      if (existing !== undefined && existing.sessionId !== sessionId) {
        store.delete(key);
      }
      if (recap !== null) {
        store.set(key, { sessionId, recap, at: Date.now(), status, source });
      } else {
        const current = store.get(key);
        if (current !== undefined) {
          store.set(key, { ...current, status });
        }
      }
    },

    get(key) {
      return store.get(key) ?? null;
    },

    prune(liveKeys) {
      for (const k of store.keys()) {
        if (!liveKeys.has(k)) store.delete(k);
      }
    },
  };
}
