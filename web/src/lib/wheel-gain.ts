import { wheelInit } from "./touch-scroll";

// Speeding up a pane means sending MORE wheel events, not bigger ones — past a ceiling xterm's own
// option cannot cross. Its mouse-reporting branch (bindMouse, the one every Claude Code pane takes) is:
//     if (0 === coreMouseService.consumeWheelEvent(...)) return false;
//     ... coreMouseService.triggerMouseEvent({ button: 4, action: deltaY < 0 ? 0 : 1 })
// consumeWheelEvent is where `scrollSensitivity` is applied, and it carries a running remainder between
// events, so the option genuinely scales how OFTEN a report is emitted. What it cannot do is emit more
// than one per event: the amount is compared against zero and then discarded. A trackpad flick or a
// finger drag clears that bar on nearly every event already, so raising the option changes nothing for
// exactly the input this setting exists for — it only helps below the ceiling, at slow tiny deltas. The
// alt-screen-without-scrollback branch emits one arrow key per event the same way.
//
// So the gain is applied here instead, ahead of xterm: swallow the real event and re-dispatch it
// `repeats` times. N events means up to N reports, which is the headroom the option does not have. Both
// paths scale — a TUI gets N reports, a shell scrolls N times — and the touch shim rides along, since its
// synthesized events pass through this listener too.

// Marks our own copies so the capture listener does not multiply them again.
const synthetic = new WeakSet<WheelEvent>();

interface WheelShape {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
}

/**
 * Whether an event should be replaced by `repeats` copies.
 *
 * Line- and page-mode events are left alone: the copies are pixel-mode (`wheelInit`), so re-emitting a
 * 3-line delta as 3 pixels would slow those browsers down instead. Safari and Chrome, desktop and iOS,
 * always report pixels. Predominantly horizontal scrolls are left alone too — the copies carry no
 * deltaX, and a terminal has nothing to scroll sideways anyway.
 */
export function shouldGain(e: WheelShape, repeats: number): boolean {
  if (repeats <= 1) return false;
  if (e.deltaMode !== 0) return false;
  return Math.abs(e.deltaY) > Math.abs(e.deltaX);
}

/**
 * Binds wheel gain to a terminal container (the same element `attachTouchScroll` takes). Capture phase,
 * so it runs before every xterm listener — all of which sit on descendants of this element.
 * Returns the detach function; call it from the effect teardown.
 */
export function attachWheelGain(el: HTMLElement, repeats: number): () => void {
  function onWheel(ev: WheelEvent): void {
    if (synthetic.has(ev)) return;
    if (!shouldGain(ev, repeats)) return;
    ev.preventDefault();
    ev.stopPropagation();
    // Dispatching on the original target keeps the bubble path — and therefore which of xterm's two
    // consumers eats the event — exactly what it would have been.
    const target = ev.target instanceof Element ? ev.target : el;
    for (let i = 0; i < repeats; i++) {
      const copy = new WheelEvent("wheel", {
        ...wheelInit(ev.deltaY, ev.clientX, ev.clientY),
        // Alt is xterm's fast-scroll modifier and Shift suppresses scrolling entirely; dropping them
        // would silently change what those gestures do.
        altKey: ev.altKey,
        ctrlKey: ev.ctrlKey,
        shiftKey: ev.shiftKey,
        metaKey: ev.metaKey,
      });
      synthetic.add(copy);
      target.dispatchEvent(copy);
    }
  }

  el.addEventListener("wheel", onWheel, { capture: true, passive: false });

  return () => {
    el.removeEventListener("wheel", onWheel, { capture: true });
  };
}
