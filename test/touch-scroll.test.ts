import { describe, expect, it } from "vitest";

import { TOUCH_SCROLL_THRESHOLD_PX, touchWheelDeltaY } from "../web/src/lib/touch-scroll";

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
