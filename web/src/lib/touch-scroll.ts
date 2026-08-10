// Touch → wheel shim for the session terminal. iOS Safari never emits `wheel` for a finger drag, and
// xterm v6 has no touch scrolling of its own: its viewport is a vscode-derived SmoothScrollableElement
// whose ONLY scroll input is a `wheel` listener, the vendored Gesture helper that would translate
// touch → scroll is never wired up (the bundle calls Gesture.ignoreTarget, never addTarget), and the
// natively-scrollable `.xterm-scroll-area` of earlier versions is gone — so a swipe over
// `.xterm-viewport` has nothing to move either. Net effect on iPhone/iPad: the pane cannot be scrolled
// at all, by any gesture.
//
// The fix is to hand xterm the one event it already understands. A synthetic pixel-mode WheelEvent
// dispatched on the touched element bubbles exactly like a real one:
//   .xterm-screen → the scrollable-element node (scrolls the local scrollback)
//                 → .xterm (bindMouse: forwards it as a mouse-wheel report to the app)
// xterm flips `handleMouseWheel` on the scrollable element whenever the app's mouse protocol changes,
// so exactly ONE of those two consumes the event — same as on desktop. That means this module needs no
// knowledge of which mode a pane is in: a plain shell scrolls its scrollback, and a mouse-reporting TUI
// (Claude Code's, see SessionModal) scrolls its own view.
//
// No inertia: a flick stops when the finger lifts. Deliberate — momentum would need its own animation
// loop, and the drag itself is 1:1 with the content, which is what makes a terminal readable on a phone.

/** Sub-pixel jitter below this is not a scroll — it keeps a tap from stealing its own default handling. */
export const TOUCH_SCROLL_THRESHOLD_PX = 2;

/**
 * Pixel wheel deltaY for a finger that moved from `fromY` to `toY`, or null when the movement is under
 * the jitter threshold (caller then leaves the event untouched). The sign is inverted relative to the
 * finger: dragging UP asks for later output, which is a positive deltaY — the direction a wheel scrolls
 * down. Pixel units, so it lands on the same code path a trackpad takes (deltaMode 0).
 */
export function touchWheelDeltaY(fromY: number, toY: number): number | null {
  const delta = fromY - toY;
  return Math.abs(delta) < TOUCH_SCROLL_THRESHOLD_PX ? null : delta;
}

// `wheelDeltaX`/`wheelDeltaY` are legacy WheelEvent members that WebKit and Blink still accept in
// WheelEventInit — and default to 0 when omitted. That default is not harmless: the vendored vscode
// StandardWheelEvent that drives xterm's scrollbar reads them FIRST and only falls back to the modern
// deltaY when they are absent (vs/base/browser/mouseEvent.ts:155). An init without them therefore
// scrolls by exactly zero, while xterm's mouse-reporting path — which reads deltaY directly — still
// works, so the pane appears to scroll under a TUI and sit dead everywhere else.
declare global {
  interface WheelEventInit {
    wheelDeltaX?: number;
    wheelDeltaY?: number;
  }
}

/**
 * WheelEventInit for a pixel scroll of `deltaY`, with the legacy fields kept consistent.
 *
 * The factor is fixed by making both readers agree: StandardWheelEvent computes `wheelDeltaY / 120` on
 * the legacy branch and `-deltaY / 40` on the modern one, so `wheelDeltaY = -3 * deltaY` — which is also
 * the conventional legacy mapping for pixel deltas.
 */
export function wheelInit(deltaY: number, clientX: number, clientY: number): WheelEventInit {
  return {
    deltaX: 0,
    deltaY,
    deltaMode: 0, // DOM_DELTA_PIXEL — xterm's cell-height accumulator and StandardWheelEvent both expect pixels
    wheelDeltaX: 0,
    wheelDeltaY: -3 * deltaY,
    clientX,
    clientY,
    bubbles: true,
    cancelable: true,
  };
}

/**
 * Binds the shim to a terminal container (anything containing the `.xterm` element — touch events from
 * the screen bubble up to it). Returns the detach function; call it from the effect teardown.
 */
export function attachTouchScroll(el: HTMLElement): () => void {
  // Non-null only while a single-finger drag is in flight. A second finger clears it so pinch-zoom and
  // the browser's own two-finger gestures are left alone.
  let lastY: number | null = null;

  function onTouchStart(e: TouchEvent): void {
    lastY = e.touches.length === 1 ? (e.touches[0]?.clientY ?? null) : null;
  }

  function onTouchMove(e: TouchEvent): void {
    if (lastY === null || e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (touch === undefined) return;
    const deltaY = touchWheelDeltaY(lastY, touch.clientY);
    if (deltaY === null) return;
    lastY = touch.clientY;
    // Requires the {passive: false} registration below. Without it the modal and the page rubber-band
    // under the terminal while it scrolls, and on iOS the drag can turn into a pull-to-refresh.
    e.preventDefault();
    // `touch.target` is where the finger went DOWN, which is the element a real wheel would target.
    const target = touch.target instanceof Element ? touch.target : el;
    target.dispatchEvent(new WheelEvent("wheel", wheelInit(deltaY, touch.clientX, touch.clientY)));
  }

  function onTouchEnd(): void {
    lastY = null;
  }

  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: false });
  el.addEventListener("touchend", onTouchEnd, { passive: true });
  el.addEventListener("touchcancel", onTouchEnd, { passive: true });

  return () => {
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
    el.removeEventListener("touchcancel", onTouchEnd);
  };
}
