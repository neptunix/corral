// A tiny TTL cache with size-bounded eviction. `get` returns the stored value, or `undefined` on a
// miss/expiry — so a cached `null` (a real value for the last-active cache) stays distinguishable from
// an absent key. Backs the /read throttle (#4) and the last-active cache; both need their own TTL, so
// it's taken at construction. `now` is injectable for deterministic tests.
export interface TtlCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  readonly size: number;
}

export function createTtlCache<V>(opts: { ttlMs: number; maxEntries?: number; now?: () => number }): TtlCache<V> {
  const { ttlMs } = opts;
  const maxEntries = opts.maxEntries ?? 500;
  const now = opts.now ?? Date.now;
  const map = new Map<string, { at: number; value: V }>();

  return {
    get(key) {
      const entry = map.get(key);
      if (entry === undefined) return undefined;
      if (now() - entry.at >= ttlMs) { map.delete(key); return undefined; }
      return entry.value;
    },
    set(key, value) {
      map.set(key, { at: now(), value });
      if (map.size <= maxEntries) return;
      // Over the bound: drop expired entries first, then evict oldest-inserted (Map preserves insertion
      // order) until within the cap — bounds memory on a long-lived server without dropping live entries
      // while any expired ones remain to reclaim.
      const t = now();
      for (const [k, e] of map) { if (t - e.at >= ttlMs) map.delete(k); }
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    get size() { return map.size; },
  };
}
