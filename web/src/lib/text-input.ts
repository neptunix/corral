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

/** The part of a keydown that says whether an input method ate the character. */
export interface KeydownFacts {
  readonly key: string;
  readonly keyCode: number;
}

/**
 * True when the IM consumed the keystroke and left the character to arrive as inserted text — the case
 * xterm cannot handle. `key === "Process"` is the spec value for exactly that and is what Firefox
 * reports behind ibus/fcitx. The keyCode 229 arm covers engines that report "Unidentified" instead, but
 * ONLY when `key` is not the character itself: iOS Safari also reports 229 for its software keyboard
 * while putting the real character in `key`, and there xterm's own _inputEvent path works — claiming
 * those would send every letter twice.
 */
export function isImSwallowedKeydown(e: KeydownFacts): boolean {
  if (e.key === "Process") return true;
  return e.keyCode === 229 && e.key.length !== 1;
}

/** The decision `beforeinput` needs, split out from the DOM so it is testable. */
export interface BeforeInputFacts {
  readonly isComposing: boolean;
  readonly inputType: string;
  readonly data: string | null;
  /** Whether the keydown that produced this insertion was IM-swallowed (isImSwallowedKeydown). */
  readonly afterImKeydown: boolean;
}

/**
 * Text to send for a `beforeinput`, or null to leave the event alone.
 *
 * Only `insertText` outside a composition, and only following an IM-swallowed keydown. Everything else
 * belongs to xterm and stealing it doubles the character: an ordinary keydown is sent by _keyDown, and
 * an insertion with no keydown at all (iOS software keyboard, dictation, autocorrect) satisfies
 * _inputEvent's `!_keyDownSeen` gate and is sent there. Deletions, history and composition inputTypes
 * fall through for the same reason.
 */
export function committedText(e: BeforeInputFacts): string | null {
  if (!e.afterImKeydown) return null;
  if (e.isComposing) return null;
  if (e.inputType !== "insertText") return null;
  return e.data !== null && e.data !== "" ? e.data : null;
}

/**
 * Binds the path to xterm's helper textarea. `send` receives the committed text; it must apply the same
 * live/OPEN gating as the onData handler.
 *
 * The keydown listener only records whether the IM ate the character; the flag is consumed by the next
 * insertion so one keydown can authorise at most one, and any keydown that is not IM-swallowed clears it.
 *
 * CAPTURE phase, and preventDefault on every claimed event: the textarea must stay byte-identical, or
 * _handleAnyTextareaChanges' pending diff sees growth and sends a second copy of the same character.
 */
export function attachCommittedTextInput(
  textarea: HTMLTextAreaElement,
  send: (text: string) => void,
): () => void {
  let afterImKeydown = false;

  function onKeyDown(e: KeyboardEvent): void {
    afterImKeydown = isImSwallowedKeydown(e);
  }

  function onBeforeInput(e: InputEvent): void {
    const text = committedText({
      isComposing: e.isComposing,
      inputType: e.inputType,
      data: e.data,
      afterImKeydown,
    });
    afterImKeydown = false;
    if (text === null) return;
    e.preventDefault();
    send(text);
  }

  textarea.addEventListener("keydown", onKeyDown, true);
  textarea.addEventListener("beforeinput", onBeforeInput, true);
  return () => {
    textarea.removeEventListener("keydown", onKeyDown, true);
    textarea.removeEventListener("beforeinput", onBeforeInput, true);
  };
}
