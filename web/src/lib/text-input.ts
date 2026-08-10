// Committed-text input path for the session terminal, bypassing xterm's textarea-diff heuristics.
//
// WHY: a keyboard routed through a Linux IM module (ibus/fcitx as GTK_IM_MODULE — the default on most
// desktops) delivers every keystroke to Firefox as keydown `{ key: "Process", keyCode: 229 }`, with the
// real character arriving only as text inserted into xterm's hidden helper textarea. xterm has no
// working path for that:
//   - CompositionHelper.keydown returns false on keyCode 229 (CompositionHelper.ts:110), so _keyDown
//     sends nothing.
//   - CoreBrowserTerminal._inputEvent, which would read ev.data directly, is gated on
//     `(!ev.composed || !this._keyDownSeen)` (CoreBrowserTerminal.ts:1196). An InputEvent is always
//     composed, and _keyDownSeen is set at the top of _keyDown and cleared only in _keyUp — so at the
//     instant the input event fires both disjuncts are false and the branch is dead.
//   - What is left is _handleAnyTextareaChanges (CompositionHelper.ts:186): a setTimeout(0) that diffs
//     the textarea with `newValue.replace(oldValue, '')` and decides by comparing lengths.
//     String.replace with a string argument cuts the FIRST occurrence rather than the prefix, and the
//     whole diff is skipped when a composition happened to start in the meantime — which is why
//     Cyrillic types intermittently while Latin (normal keyCode, handled on keydown) always works.
//
// This module takes the character from the event that actually carries it: `beforeinput`. Latin never
// reaches it — xterm's _keyDown/_keyPress call preventDefault on the key event, which suppresses the
// text insertion and hence beforeinput entirely. Only input xterm did NOT already consume gets here,
// which is exactly the set its diff was guessing at.
//
// Composition (candidate windows, dead keys) is left untouched: those events carry isComposing or the
// insertCompositionText inputType, and xterm's CompositionHelper still owns the preedit overlay and the
// commit. Only committed plain text is claimed.

/** The decision `beforeinput` needs, split out from the DOM so it is testable. */
export interface BeforeInputFacts {
  readonly isComposing: boolean;
  readonly inputType: string;
  readonly data: string | null;
}

/**
 * Text to send for a `beforeinput`, or null to leave the event alone.
 *
 * Only `insertText` outside a composition is claimed. Deletions, history (undo/redo), drops and every
 * composition inputType fall through: Backspace and friends arrive as real keys that xterm's keydown
 * path already handles, and stealing them here would double them up.
 */
export function committedText(e: BeforeInputFacts): string | null {
  if (e.isComposing) return null;
  if (e.inputType !== "insertText") return null;
  return e.data !== null && e.data !== "" ? e.data : null;
}

/**
 * One-slot guard so a single keystroke cannot reach the socket twice. Both senders — xterm's onData and
 * the beforeinput path below — claim through it, and the first one for a given text wins.
 *
 * Needed because the two paths are not mutually exclusive on every platform. On Linux/Firefox behind an
 * IM module only beforeinput carries the character, which is the whole point of this module; on iOS
 * Safari the software keyboard ALSO drives one of xterm's own paths, and preventDefault does not
 * reliably suppress the insertion, so the same letter arrived twice. Rather than enumerate which
 * internal path fires where, dedupe on the one fact that matters: the same text, for the same key event.
 *
 * Ordering makes the window exact. Within one key event the possible sends are, in order:
 *   (a) xterm's keydown/keypress handler, (b) this module's beforeinput, (c) xterm's textarea diff,
 * where (c) is a setTimeout(0) armed back at keydown. A claim arms its own setTimeout(0) release, and
 * same-delay timers fire in the order they were scheduled — so (c)'s timer, scheduled first, always runs
 * while the slot is still held. Two genuine presses of the same key are separate tasks tens of
 * milliseconds apart (even at auto-repeat), so the slot is long released by the second.
 */
export interface EchoGuard {
  /** True when the caller should send; false when an identical send already happened for this key event. */
  readonly claim: (text: string) => boolean;
}

/** `defer` is injectable so tests can drive the release without timers. */
export function createEchoGuard(defer: (fn: () => void) => void = (fn) => { setTimeout(fn, 0); }): EchoGuard {
  let inFlight: string | null = null;
  return {
    claim(text: string): boolean {
      if (inFlight === text) return false;
      inFlight = text;
      defer(() => { inFlight = null; });
      return true;
    },
  };
}

/**
 * Binds the path to xterm's helper textarea. `send` receives the committed text; it must apply the same
 * live/OPEN gating as the onData handler, and claim through the shared EchoGuard.
 *
 * CAPTURE phase, and preventDefault on every claimed event: where the browser honours it the textarea
 * stays byte-identical, so xterm's pending diff sees no growth and never sends a second copy. Where it
 * does not (iOS), the EchoGuard catches what gets through.
 */
export function attachCommittedTextInput(
  textarea: HTMLTextAreaElement,
  send: (text: string) => void,
): () => void {
  function onBeforeInput(e: InputEvent): void {
    const text = committedText(e);
    if (text === null) return;
    e.preventDefault();
    send(text);
  }
  textarea.addEventListener("beforeinput", onBeforeInput, true);
  return () => { textarea.removeEventListener("beforeinput", onBeforeInput, true); };
}
