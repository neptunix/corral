import { MIN_SIZED_COLS } from "../config.ts";

/**
 * The size of the operator's terminal panel, as last reported by an attach's `resize` control frame.
 *
 * Process-local and deliberately not persisted: it is evidence about a browser window that exists
 * right now, and a stale value read off disk after a restart would be a guess. Empty means "corral
 * has not seen a panel yet" — callers leave the decision to herdr rather than inventing a width.
 *
 * A reading narrower than MIN_SIZED_COLS is dropped, keeping whatever is already stored — a narrow
 * reading carries no information, and storing it would evict a genuinely wide one.
 */
export interface Viewport {
  readonly cols: number;
  readonly rows: number;
}

let last: Viewport | null = null;

export function recordViewport(cols: number, rows: number): void {
  if (cols < MIN_SIZED_COLS) return;
  last = { cols, rows };
}

export function lastViewport(): Viewport | null {
  return last;
}
