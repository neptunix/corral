import { useEffect, useState, type JSX } from "react";

import { ARROW_KEYS, arrowSequence, BAR_KEYS } from "../lib/key-bar";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs";

interface Props {
  /** Sends one keystroke into the pane. Same channel as typed input. */
  readonly onKey: (seq: string) => void;
  /** DECCKM, read live from the terminal — arrows change spelling under it. */
  readonly applicationCursorKeys: () => boolean;
  /** Arms/disarms Ctrl for the next character typed on the soft keyboard. */
  readonly onCtrlArmedChange: (armed: boolean) => void;
  /** Cleared by the owner once a typed character consumed the modifier. */
  readonly ctrlArmed: boolean;
  /** Restores focus if a press managed to take it. A no-op when it did not — see Key. */
  readonly refocus: () => void;
  /** Reads the clipboard and injects it. iOS offers no paste menu over the terminal. */
  readonly onPaste: () => void;
}

// Spans with role=button, NOT <button>. A real button is focusable, so tapping one takes focus off
// the terminal's textarea and iOS closes the keyboard; asking for focus back then reopens it, which
// is the flicker — and on a key that does not restore focus, like Ctrl, the keyboard just stays
// closed. An element with no tabindex cannot be focused by a tap at all, so focus never moves and
// there is nothing to restore. The bar is coarse-pointer only, so being unreachable by Tab costs
// nothing: a device with a Tab key has the real keys too.
//
// touch-manipulation is load-bearing as well. Without it a quick second tap is a double-tap gesture,
// and Safari answers that by zooming and dropping focus — closing the keyboard mid-way through
// arrowing down a list. Declaring the element has no double-tap meaning removes the gesture (and the
// 300 ms click delay with it).
const BTN = "cursor-pointer min-w-9 h-9 px-2 rounded border border-border bg-muted/60 text-foreground " +
  "text-xs font-mono leading-none flex items-center justify-center active:bg-muted select-none touch-manipulation";

function Key(
  { label, name, onPress, className = "", pressed, expanded }: {
    readonly label: string;
    readonly name: string;
    readonly onPress: () => void;
    readonly className?: string;
    readonly pressed?: boolean;
    readonly expanded?: boolean;
  },
): JSX.Element {
  return (
    <span
      role="button"
      title={name}
      aria-label={name}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      {...(expanded === undefined ? {} : { "aria-expanded": expanded })}
      className={`${BTN} ${className}`}
      // Both handlers: preventDefault on mousedown is what stops a desktop pointer from moving focus,
      // and pointerdown is what fires first on touch. Acting on the down event rather than on click
      // also means the key repeats as fast as the finger can tap.
      onMouseDown={(e) => { e.preventDefault(); }}
      onPointerDown={(e) => { e.preventDefault(); onPress(); }}
    >{label}</span>
  );
}

/**
 * On-screen keys for touch devices. A phone's soft keyboard has no arrows, Esc, Tab or Ctrl, so every
 * TUI that asks a question with a list is unanswerable without this.
 *
 * Ctrl is STICKY rather than held: there is no chord on a touchscreen. Armed, it applies to the next
 * key from this bar or the next character from the soft keyboard, then clears itself — the owner
 * clears it for the typed case, which is why `ctrlArmed` is a prop and not local state.
 *
 * Collapsing is remembered per device, next to the scroll speed: the bar costs a row of a phone
 * screen, and someone reading long output wants that row back without losing it for good.
 *
 * Paste is here for the same reason the arrows are. iOS raises its paste callout over an editable or
 * selectable element, and the terminal is neither: xterm's helper textarea sits off-screen at
 * left:-9999em and `.xterm` is user-select:none, so a long press finds nothing to offer a menu for.
 */
export function KeyBar({
  onKey, applicationCursorKeys, onCtrlArmedChange, ctrlArmed, refocus, onPaste,
}: Props): JSX.Element | null {
  // Pointer, not width: a tablet in landscape is wide and still has no arrow keys, and a narrow
  // desktop window has both. `matchMedia` is read in an effect so the first render is stable and a
  // device that changes pointer (a tablet gaining a keyboard) re-evaluates.
  const [coarse, setCoarse] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setHidden(readTerminalPrefs().keyBarHidden);
    // Feature-detected exactly like ThemeProvider does it: matchMedia is absent under jsdom, and a
    // bar that throws would take the whole modal down with it. Absent means "assume a real pointer" —
    // hiding the bar is the safe default, since a device with arrow keys loses nothing.
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(pointer: coarse)");
    const sync = (): void => { setCoarse(mq.matches); };
    sync();
    mq.addEventListener("change", sync);
    return () => { mq.removeEventListener("change", sync); };
  }, []);

  if (!coarse) return null;

  function setHiddenPref(next: boolean): void {
    setHidden(next);
    writeTerminalPrefs({ keyBarHidden: next });
    refocus();
  }

  function press(seq: string): void {
    onKey(seq);
    if (ctrlArmed) onCtrlArmedChange(false);
    refocus();
  }

  if (hidden) {
    // ABSOLUTE, so it occupies no height at all: the whole point of collapsing is to hand those rows
    // to the terminal, and a button left in the flex column would keep most of them. It floats over
    // the output in the corner instead, dimmed until touched, and the terminal's ResizeObserver
    // refits into the space the bar gave up.
    return (
      <Key
        label="⌨"
        name="Show keys"
        expanded={false}
        className="absolute bottom-1 right-1 z-10 min-w-0 h-7 w-7 px-0 bg-card/70 opacity-60 active:opacity-100"
        onPress={() => { setHiddenPref(false); }}
      />
    );
  }

  return (
    // shrink-0 so the bar never gets squeezed to nothing by the terminal's flex-1 above it.
    <div className="shrink-0 flex items-center gap-1 px-1 py-1 border-t border-border overflow-x-auto">
      {BAR_KEYS.map((k) => (
        <Key key={k.id} label={k.label} name={k.title} onPress={() => { press(k.seq); }} />
      ))}
      <Key
        label="ctrl"
        name="Ctrl"
        pressed={ctrlArmed}
        className={ctrlArmed ? "bg-primary text-primary-foreground border-primary" : ""}
        onPress={() => { onCtrlArmedChange(!ctrlArmed); refocus(); }}
      />
      <Key label="paste" name="Paste" onPress={onPaste} />
      {ARROW_KEYS.map((a) => (
        <Key
          key={a.id}
          label={a.label}
          name={a.title}
          onPress={() => {
            press(arrowSequence(a.id, { applicationCursorKeys: applicationCursorKeys(), ctrl: ctrlArmed }));
          }}
        />
      ))}
      <Key label="▾" name="Hide keys" expanded className="ml-auto" onPress={() => { setHiddenPref(true); }} />
    </div>
  );
}
