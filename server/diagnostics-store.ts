import type { Check, CheckClass, DiagnosticsSnapshot, SelfInfo } from "@shared/diagnostics-schema";
import { CheckClassSchema, computeRollup } from "@shared/diagnostics-schema";

/**
 * The in-memory home of every check result, keyed by COST CLASS rather than by check id.
 *
 * Why the class is the storage granularity: each class runs on its own cadence, and a class's
 * producer set is the only thing that knows the full row set for that class. Replacing a class
 * wholesale is therefore the only update that can make a resolved problem disappear — a per-row
 * merge would leave the row from the last sweep that still saw it, forever. And because the
 * replacement is wholesale, `versions` must not share a bucket with `cheap`: those rows carry their
 * own TTL, so filed together they would vanish and reappear on every 60-second sweep.
 */
export interface DiagnosticsStore {
  /** Replace one cost class wholesale — a partial update would strand resolved problems. */
  put(cls: CheckClass, checks: readonly Check[]): void;
  patchSelf(patch: Partial<SelfInfo>): void;
  /** Record (or clear, with null) the last sweep failure — see `lastError` on the snapshot. */
  setLastError(message: string | null): void;
  snapshot(): DiagnosticsSnapshot;
}

/**
 * Declaration order of `CheckClassSchema`, so `answered` is stable across snapshots rather than
 * following the order the classes happened to be swept in — the rail would otherwise see the array
 * change with nothing behind it having changed.
 */
const CLASS_ORDER: readonly CheckClass[] = CheckClassSchema.options;

export function createDiagnosticsStore(opts: { selfVersion: string | null }): DiagnosticsStore {
  const byClass = new Map<CheckClass, readonly Check[]>();
  let self: SelfInfo = {
    version: opts.selfVersion, latest: null, releaseUrl: null, latestCheckedAt: null,
  };
  let lastError: string | null = null;

  return {
    put(cls, checks) {
      // A copy, not the caller's array: the sweep composes its list with spreads and the web sorts
      // `checks` in place, so a shared reference would let either mutate what the other publishes.
      byClass.set(cls, [...checks]);
    },
    patchSelf(patch) {
      self = { ...self, ...patch };
    },
    setLastError(message) {
      lastError = message;
    },
    snapshot() {
      // An EMPTY array of rows for an answered class is still an answer — presence of the key, not a
      // non-empty value, is what distinguishes "nothing is wrong" from "nothing has run yet".
      const answered = CLASS_ORDER.filter((cls) => byClass.has(cls));
      const checks = answered.flatMap((cls) => byClass.get(cls) ?? []);
      // Recomputed here rather than maintained incrementally: one pass over a few dozen rows costs
      // nothing, and an incremental counter is one missed `put` away from disagreeing with the rows
      // it summarizes.
      return { checks, rollup: computeRollup(checks), answered, lastError, self };
    },
  };
}
