export function makeGuarded(task: () => Promise<void>): () => Promise<void> {
  let pending = false;
  return async () => {
    if (pending) return;
    pending = true;
    try {
      await task();
    } finally {
      pending = false;
    }
  };
}

export function guardedInterval(task: () => Promise<void>, intervalMs: number): () => void {
  const tick = makeGuarded(task);
  const id = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => { clearInterval(id); };
}
