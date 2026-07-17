import type { StatuslineData, StatuslineStatus } from "@shared/schema";

export interface StatuslineCacheEntry {
  readonly sessionId: string;
  readonly data: StatuslineData | null;
  readonly at: number;
  readonly status: StatuslineStatus;
}

export interface StatuslineCache {
  update(key: string, sessionId: string, data: StatuslineData | null, status: StatuslineStatus): void;
  get(key: string): StatuslineCacheEntry | null;
  prune(liveKeys: ReadonlySet<string>): void;
}

export function createStatuslineCache(): StatuslineCache {
  const store = new Map<string, StatuslineCacheEntry>();

  return {
    update(key, sessionId, data, status) {
      const existing = store.get(key);
      if (existing !== undefined && existing.sessionId !== sessionId) {
        store.delete(key);
      }
      if (data !== null) {
        store.set(key, { sessionId, data, at: Date.now(), status });
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
