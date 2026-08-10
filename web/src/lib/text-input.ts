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
 * Binds the path to xterm's helper textarea. `send` receives the committed text; it must apply the same
 * live/OPEN gating as the onData handler.
 *
 * CAPTURE phase, and preventDefault on every claimed event: the textarea must stay byte-identical, or
 * _handleAnyTextareaChanges' pending diff sees growth and sends a second copy of the same character.
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
