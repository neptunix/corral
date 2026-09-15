// A pty resize is not free: the application on the other end repaints, and whatever it had already
// drawn is pushed into scrollback. One resize costs one stale copy of the UI in the history — a burst
// of them costs a burst, which is what reading back through the pane then looks like.
//
// A ResizeObserver produces exactly such a burst. A phone's keyboard slides in over several frames
// and the observer fires on each one; so does a desktop window drag. Only the size it settles on is
// worth telling the pty about.

export interface Dims {
  readonly cols: number;
  readonly rows: number;
}

export interface ResizeGate {
  /** Resize now — for the first fit, where waiting would show a wrongly sized UI. */
  readonly now: () => void;
  /** Resize once the size stops changing. */
  readonly later: () => void;
  readonly dispose: () => void;
}

export const RESIZE_SETTLE_MS = 150;

/**
 * `perform` refits and reports the resulting dimensions; `emit` tells the pty. Split because the
 * dimensions are only known after the refit, and because the refit is the part that must not run
 * per animation frame either — xterm rounds to whole rows, so an in-between size is a real resize of
 * the local buffer too.
 *
 * `emit` is skipped when the settled size matches the last one sent. A ResizeObserver fires for
 * changes that do not cross a cell boundary, and an unchanged geometry still makes the application
 * repaint if it is sent.
 */
export function createResizeGate(opts: {
  readonly perform: () => Dims;
  readonly emit: (dims: Dims) => void;
  readonly delayMs?: number;
}): ResizeGate {
  const delayMs = opts.delayMs ?? RESIZE_SETTLE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: Dims | null = null;

  function run(): void {
    const dims = opts.perform();
    if (last !== null && last.cols === dims.cols && last.rows === dims.rows) return;
    last = dims;
    opts.emit(dims);
  }

  return {
    now(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      run();
    },
    later(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; run(); }, delayMs);
    },
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
