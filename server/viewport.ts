/**
 * The size of the operator's terminal panel, as last reported by an attach's `resize` control frame.
 *
 * Process-local and deliberately not persisted: it is evidence about a browser window that exists
 * right now, and a stale value read off disk after a restart would be a guess. Empty means "corral has
 * not seen a panel yet" — callers leave the decision to herdr rather than inventing a width.
 *
 * ONE write site, in the attach path (server/ws-attach.ts wires the pty bridge's `onResize`). The
 * pty's own spawn size is never recorded: the fallback chain there can end at 80x24, and recording
 * that would poison a good reading.
 */
export interface Viewport {
  readonly cols: number;
  readonly rows: number;
}

let last: Viewport | null = null;

export function recordViewport(cols: number, rows: number): void {
  last = { cols, rows };
}

export function lastViewport(): Viewport | null {
  return last;
}
