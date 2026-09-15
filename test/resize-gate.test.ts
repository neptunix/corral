import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createResizeGate, type Dims } from "../web/src/lib/resize-gate";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function gate(sizes: Dims[]) {
  const emit = vi.fn();
  let i = 0;
  const perform = vi.fn((): Dims => sizes[Math.min(i++, sizes.length - 1)] ?? { cols: 80, rows: 24 });
  return { emit, perform, g: createResizeGate({ perform, emit, delayMs: 100 }) };
}

const S = (rows: number): Dims => ({ cols: 80, rows });

describe("createResizeGate", () => {
  it("collapses a burst into the size it settles on", () => {
    // A keyboard sliding in fires the observer once per frame; only the last size is real.
    const { emit, perform, g } = gate([S(20), S(16), S(12)]);
    g.later(); g.later(); g.later();
    vi.advanceTimersByTime(100);

    expect(perform).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(S(20));
  });

  it("does nothing until the size stops changing", () => {
    const { emit, g } = gate([S(20)]);
    g.later();
    vi.advanceTimersByTime(99);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("skips a settled size identical to the last one sent", () => {
    // The observer also fires for changes too small to cross a cell boundary; resending would still
    // make the application repaint.
    const { emit, g } = gate([S(24), S(24)]);
    g.now();
    g.later();
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("emits again once the size really changes", () => {
    const { emit, g } = gate([S(24), S(12)]);
    g.now();
    g.later();
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenNthCalledWith(2, S(12));
  });

  it("resizes immediately on `now`, and that cancels a pending settle", () => {
    const { emit, perform, g } = gate([S(30), S(10)]);
    g.later();
    g.now();
    vi.advanceTimersByTime(500);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(S(30));
  });

  it("drops a pending resize on dispose, so a torn-down terminal is never refit", () => {
    const { emit, perform, g } = gate([S(20)]);
    g.later();
    g.dispose();
    vi.advanceTimersByTime(500);
    expect(perform).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
