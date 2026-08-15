// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { useEventSource } from "../web/src/useEventSource";

const Schema = z.object({ n: z.number() });

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.last = this; }
  close(): void { this.closed = true; }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const es = (): FakeEventSource => {
  const cur = FakeEventSource.last;
  if (cur === null) throw new Error("no EventSource constructed");
  return cur;
};
const frame = (n: number): MessageEvent<string> =>
  new MessageEvent("message", { data: JSON.stringify({ n }) });

describe("useEventSource connection status", () => {
  it("stays clear when an error recovers inside the window", () => {
    const { result } = renderHook(() => useEventSource("/s", Schema, 10_000));
    act(() => { es().onerror?.(); });
    act(() => { vi.advanceTimersByTime(5_000); es().onopen?.(); });
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(result.current.streamDown).toBe(false);
  });

  // THE REGRESSION GUARD: a timer re-armed on each retry would never elapse, so the outage would
  // never be reported at all. The browser really does fire onerror on every reconnect attempt.
  it("reports the outage despite a retry storm across the window", () => {
    const { result } = renderHook(() => useEventSource("/s", Schema, 10_000));
    for (let i = 0; i < 5; i += 1) act(() => { es().onerror?.(); vi.advanceTimersByTime(3_000); });
    expect(result.current.streamDown).toBe(true);
  });

  it("clears the outage when a frame arrives", () => {
    const { result } = renderHook(() => useEventSource("/s", Schema, 10_000));
    act(() => { es().onerror?.(); vi.advanceTimersByTime(11_000); });
    expect(result.current.streamDown).toBe(true);
    act(() => { es().onmessage?.(frame(1)); });
    expect(result.current.streamDown).toBe(false);
  });

  // Asserting `streamDown === false` after unmount cannot fail — it is already false and the hook is
  // gone. Assert the mechanism: the pending timer is actually cancelled and the stream closed.
  it("cancels the pending timer and closes the stream on unmount", () => {
    const { unmount } = renderHook(() => useEventSource("/s", Schema, 10_000));
    act(() => { es().onerror?.(); });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(es().closed).toBe(true);
  });

  it("cancels a pending timer when the url changes", () => {
    const { rerender } = renderHook(({ url }) => useEventSource(url, Schema, 10_000),
      { initialProps: { url: "/a" } });
    act(() => { es().onerror?.(); });
    rerender({ url: "/b" });
    expect(vi.getTimerCount()).toBe(0);
  });

  // App keys an effect on the frame's identity; a new object per render wipes the optimistic overlay.
  it("keeps the frame referentially identical while the status flips", () => {
    const { result } = renderHook(() => useEventSource("/s", Schema, 10_000));
    act(() => { es().onmessage?.(frame(1)); });
    const first = result.current.frame;
    act(() => { es().onerror?.(); vi.advanceTimersByTime(11_000); });
    expect(result.current.streamDown).toBe(true);
    expect(result.current.frame).toBe(first);
  });
});
