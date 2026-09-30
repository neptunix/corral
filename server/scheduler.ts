export function makeGuarded(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  return async () => {
    // A mid-run caller (whoami's re-poll) needs the fresh snapshot, so it waits instead of returning early.
    if (running !== null) return running.catch(() => undefined);
    running = task();
    try {
      await running;
    } finally {
      running = null;
    }
  };
}

/**
 * Drive an ALREADY-guarded tick on an interval. Split out from `guardedInterval` so a caller that
 * also needs to invoke the same task on demand can build one guard and share it between the timer
 * and the on-demand path — two separate guards would let the two overlap, which is the exact race
 * `makeGuarded` exists to prevent.
 */
export function runGuarded(tick: () => Promise<void>, intervalMs: number): () => void {
  const id = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => { clearInterval(id); };
}

export function guardedInterval(task: () => Promise<void>, intervalMs: number): () => void {
  return runGuarded(makeGuarded(task), intervalMs);
}
