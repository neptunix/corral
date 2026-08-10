import { describe, expect, it } from "vitest";

import { TOUCH_SCROLL_THRESHOLD_PX, touchWheelDeltaY, wheelInit } from "../web/src/lib/touch-scroll";

describe("touchWheelDeltaY", () => {
  it("maps a finger dragged up to a positive (scroll-down) deltaY", () => {
    // Finger travels 100px toward the top of the screen → show later output, like a wheel scrolled down.
    expect(touchWheelDeltaY(300, 200)).toBe(100);
  });

  it("maps a finger dragged down to a negative (scroll-up) deltaY", () => {
    expect(touchWheelDeltaY(200, 300)).toBe(-100);
  });

  it("is 1:1 in pixels, so the content tracks the finger", () => {
    expect(touchWheelDeltaY(500, 483)).toBe(17);
  });

  it("swallows sub-threshold jitter so a wobbling tap keeps its default handling", () => {
    expect(touchWheelDeltaY(300, 300)).toBeNull();
    expect(touchWheelDeltaY(300, 300 - (TOUCH_SCROLL_THRESHOLD_PX - 0.5))).toBeNull();
    expect(touchWheelDeltaY(300, 300 + (TOUCH_SCROLL_THRESHOLD_PX - 0.5))).toBeNull();
  });

  it("emits at exactly the threshold", () => {
    expect(touchWheelDeltaY(300, 300 - TOUCH_SCROLL_THRESHOLD_PX)).toBe(TOUCH_SCROLL_THRESHOLD_PX);
  });
});

describe("wheelInit", () => {
  // Regression: omitting the legacy fields leaves them 0 in WebKit/Blink, and vscode's
  // StandardWheelEvent prefers them over deltaY — so the scrollbar moved by nothing.
  it("carries a legacy wheelDeltaY consistent with deltaY", () => {
    const init = wheelInit(80, 10, 20);
    expect(init.wheelDeltaY).toBe(-240);
    // Both StandardWheelEvent branches must land on the same normalized value.
    expect((init.wheelDeltaY ?? 0) / 120).toBe(-(init.deltaY ?? 0) / 40);
  });

  it("keeps the legacy field signed with the modern one in both directions", () => {
    expect(wheelInit(-80, 0, 0).wheelDeltaY).toBe(240);
    expect(wheelInit(0, 0, 0).wheelDeltaY).toBe(-0);
  });

  it("stays a pixel-mode, bubbling, cancelable event at the touch point", () => {
    const init = wheelInit(17, 42, 99);
    expect(init).toMatchObject({
      deltaX: 0, deltaY: 17, deltaMode: 0, wheelDeltaX: 0,
      clientX: 42, clientY: 99, bubbles: true, cancelable: true,
    });
  });
});
