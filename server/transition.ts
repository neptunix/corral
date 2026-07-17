import type { SessionRow } from "@shared/schema";

export type WorkingMap = Record<string, number>;

export interface TransitionEvent {
  readonly key: string;
  readonly state: "blocked" | "finished";
  readonly since: number;
  readonly row: SessionRow;
}

export interface TransitionResult {
  readonly events: readonly TransitionEvent[];
  readonly working: WorkingMap;
  readonly clearedKeys: readonly string[];
}

const rowKey = (r: SessionRow): string => `${r.env}:${r.paneId}`;

/**
 * Pure per-env transition detector. `prev`/`curr` are ONE env's rows; `working` is the global map
 * (only this env's keys are read/written). See §3.1 for the rule set.
 *
 * The working map is built into a `Map` internally (its `.delete()` method drops keys without the
 * `delete` operator, which `no-dynamic-delete` forbids) and returned as a plain `Record`.
 */
export function detectTransitions(
  prev: readonly SessionRow[],
  curr: readonly SessionRow[],
  working: WorkingMap,
  nowMs: number,
  minWorkMs: number,
): TransitionResult {
  const prevStatus = new Map<string, string>();
  for (const r of prev) prevStatus.set(rowKey(r), r.status);
  const currKeys = new Set(curr.map(rowKey));

  const nextWorking = new Map<string, number>(Object.entries(working));
  const events: TransitionEvent[] = [];
  const clearedKeys: string[] = [];

  for (const r of curr) {
    const key = rowKey(r);
    const prior = prevStatus.get(key);
    const workingSince = nextWorking.get(key);

    if (r.status === "working") {
      if (workingSince === undefined) nextWorking.set(key, nowMs); // seed to now (restart-safe)
      clearedKeys.push(key); // re-working clears any record (no-op if none); timer kept/seeded above
    } else if (r.status === "idle" || r.status === "done" || r.status === "blocked") {
      if (
        prior === "working" &&
        (r.status === "done" || r.status === "idle") &&
        workingSince !== undefined &&
        nowMs - workingSince >= minWorkMs
      ) {
        events.push({ key, state: "finished", since: nowMs, row: r });
      }
      nextWorking.delete(key); // known non-working → drop so a future re-work re-seeds
    }
    // unrecognized status: inert — no event, working map untouched

    if (r.status === "blocked" && prior !== "blocked") {
      events.push({ key, state: "blocked", since: nowMs, row: r });
    }
  }

  for (const r of prev) {
    const key = rowKey(r);
    if (!currKeys.has(key)) {
      clearedKeys.push(key);
      nextWorking.delete(key); // disappeared → bounded growth
    }
  }

  return { events, working: Object.fromEntries(nextWorking), clearedKeys };
}
