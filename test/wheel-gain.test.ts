// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { touchWheelDeltaY, wheelInit } from "../web/src/lib/touch-scroll";
import { attachWheelGain, shouldGain } from "../web/src/lib/wheel-gain";

let detach: (() => void) | null = null;

afterEach(() => {
  detach?.();
  detach = null;
  document.body.innerHTML = "";
});

function mount(): { container: HTMLElement; screen: HTMLElement; seen: WheelEvent[] } {
  const container = document.createElement("div");
  const screen = document.createElement("div"); // stands in for .xterm, where xterm's own listeners live
  container.appendChild(screen);
  document.body.appendChild(container);
  const seen: WheelEvent[] = [];
  screen.addEventListener("wheel", (e) => { seen.push(e); });
  return { container, screen, seen };
}

function wheel(deltaY: number, init: WheelEventInit = {}): WheelEvent {
  return new WheelEvent("wheel", { deltaY, deltaMode: 0, bubbles: true, cancelable: true, ...init });
}

describe("wheel gain — what qualifies", () => {
  it("declines to touch anything at a gain of 1", () => {
    expect(shouldGain({ deltaX: 0, deltaY: 40, deltaMode: 0 }, 1)).toBe(false);
  });

  // The copies are pixel-mode, so re-emitting a 3-LINE delta as 3 pixels would be a slowdown.
  it("leaves line- and page-mode events alone", () => {
    expect(shouldGain({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 5)).toBe(false);
    expect(shouldGain({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 5)).toBe(false);
  });

  it("leaves a predominantly horizontal scroll alone", () => {
    expect(shouldGain({ deltaX: 80, deltaY: 10, deltaMode: 0 }, 5)).toBe(false);
  });

  it("takes an ordinary vertical pixel scroll", () => {
    expect(shouldGain({ deltaX: 0, deltaY: 40, deltaMode: 0 }, 5)).toBe(true);
    expect(shouldGain({ deltaX: 0, deltaY: -40, deltaMode: 0 }, 5)).toBe(true);
  });
});

describe("wheel gain — dispatch", () => {
  // The whole point: xterm emits one mouse report per EVENT, so N events is the only way to scroll N×.
  it("replaces one event with `repeats` copies", () => {
    const { container, screen, seen } = mount();
    detach = attachWheelGain(container, 4);

    screen.dispatchEvent(wheel(40));

    expect(seen).toHaveLength(4);
    expect(seen.every((e) => e.deltaY === 40)).toBe(true);
  });

  it("does not multiply its own copies", () => {
    const { container, screen, seen } = mount();
    detach = attachWheelGain(container, 3);

    screen.dispatchEvent(wheel(40));

    expect(seen).toHaveLength(3);
  });

  it("swallows the original so the event is not counted twice", () => {
    const { container, screen, seen } = mount();
    detach = attachWheelGain(container, 2);

    const original = wheel(40);
    const prevented = !screen.dispatchEvent(original);

    expect(prevented).toBe(true);
    expect(seen).not.toContain(original);
  });

  it("carries the modifier keys onto every copy", () => {
    const { container, screen, seen } = mount();
    detach = attachWheelGain(container, 2);

    screen.dispatchEvent(wheel(40, { altKey: true, shiftKey: true }));

    expect(seen.every((e) => e.altKey && e.shiftKey)).toBe(true);
  });

  // Cancelling an event it declined to multiply would kill native scrolling and still show green.
  it("passes an event through untouched, and uncancelled, at a gain of 1", () => {
    const { container, screen, seen } = mount();
    detach = attachWheelGain(container, 1);

    const original = wheel(40);
    const notCancelled = screen.dispatchEvent(original);

    expect(seen).toEqual([original]);
    expect(notCancelled).toBe(true);
  });

  it("leaves a line-mode event alone rather than cancelling it", () => {
    const { container, screen, seen } = mount();
    detach = attachWheelGain(container, 5);

    const original = wheel(3, { deltaMode: 1 });
    const notCancelled = screen.dispatchEvent(original);

    expect(seen).toEqual([original]);
    expect(notCancelled).toBe(true);
  });

  it("stops on detach", () => {
    const { container, screen, seen } = mount();
    const off = attachWheelGain(container, 5);
    off();

    screen.dispatchEvent(wheel(40));

    expect(seen).toHaveLength(1);
  });

  // The seam with the touch shim: on a phone the gain only works if the events touch-scroll synthesizes
  // qualify. jsdom has no Touch constructor, so the shim's own event factory stands in for the finger.
  it("gains the events the touch shim synthesizes", () => {
    const { container, screen, seen } = mount();
    detach = attachWheelGain(container, 4);

    const fingerDelta = touchWheelDeltaY(300, 283);
    if (fingerDelta === null) throw new Error("17px is above the jitter threshold");
    screen.dispatchEvent(new WheelEvent("wheel", wheelInit(fingerDelta, 10, 283)));

    expect(seen).toHaveLength(4);
    expect(seen.every((e) => e.deltaY === fingerDelta)).toBe(true);
  });

  // The copies are built by `wheelInit`, whose legacy wheelDeltaY mapping is pinned in
  // touch-scroll.test.ts — jsdom drops those fields, so it cannot be asserted on an event here.
  // A momentum burst is many events and each is multiplied, so traffic scales with the gain.
  it("sends exactly `repeats` copies per event, no more", () => {
    const { container, screen, seen } = mount();
    detach = attachWheelGain(container, 10);

    screen.dispatchEvent(wheel(40));
    screen.dispatchEvent(wheel(40));

    expect(seen).toHaveLength(20);
  });
});
