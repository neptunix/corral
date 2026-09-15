// The keys a phone keyboard does not have. Without them no TUI select prompt is answerable from a
// touch device — arrows, Esc and Tab simply cannot be typed, so a list of options is a dead end
// (this started with Claude's trust dialog, which needs ↑/↓ to move off the default).

/** A control character: Ctrl+A is 0x01 … Ctrl+Z is 0x1a, and @[\]^_ continue the run to 0x00…0x1f. */
export function controlCode(char: string): string | null {
  if (char.length !== 1) return null;
  const upper = char.toUpperCase();
  const code = upper.charCodeAt(0);
  // 0x40 '@' … 0x5f '_' is the whole caret-notation range; subtracting 64 lands on the control code.
  if (code < 0x40 || code > 0x5f) return null;
  return String.fromCharCode(code - 0x40);
}

export type Arrow = "up" | "down" | "left" | "right";

const ARROW_FINAL: Record<Arrow, string> = { up: "A", down: "B", right: "C", left: "D" };

/**
 * The bytes for an arrow key.
 *
 * `applicationCursorKeys` is DECCKM (read from xterm's own `term.modes`, never assumed): in that mode
 * a terminal sends SS3 `ESC O A` instead of CSI `ESC [ A`, and an app that asked for it will not
 * recognise the other form. Ctrl adds the xterm modifier parameter — always CSI, because the
 * parameterised form has no SS3 spelling.
 */
export function arrowSequence(
  arrow: Arrow,
  opts: { readonly applicationCursorKeys: boolean; readonly ctrl: boolean },
): string {
  const final = ARROW_FINAL[arrow];
  if (opts.ctrl) return `\x1b[1;5${final}`;
  return opts.applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`;
}

/** A plain (non-arrow) key on the bar. `label` is what the button shows. */
export interface BarKey {
  readonly id: string;
  readonly label: string;
  readonly seq: string;
  /** Screen-reader name, since the labels are glyphs. */
  readonly title: string;
}

export const BAR_KEYS: readonly BarKey[] = [
  { id: "esc", label: "esc", seq: "\x1b", title: "Escape" },
  { id: "tab", label: "tab", seq: "\t", title: "Tab" },
];

export const ARROW_KEYS: readonly { readonly id: Arrow; readonly label: string; readonly title: string }[] = [
  { id: "left", label: "←", title: "Left arrow" },
  { id: "down", label: "↓", title: "Down arrow" },
  { id: "up", label: "↑", title: "Up arrow" },
  { id: "right", label: "→", title: "Right arrow" },
];

/**
 * Applies an armed sticky Ctrl to one chunk of user input.
 *
 * `consumed` says whether the modifier was spent, and it is deliberately false for anything that is
 * not a single character. Typed text is not the only thing on the input channel — a mouse report or
 * an escape sequence arrives there too (touch-scroll turns a swipe into wheel reports), and eating
 * the modifier on one of those would drop it without the operator ever pressing a key. A single
 * character with no control code still consumes it: leaving it armed would silently modify some
 * later, unrelated key.
 */
export function applyStickyCtrl(input: string, armed: boolean): { text: string; consumed: boolean } {
  if (!armed || input.length !== 1) return { text: input, consumed: false };
  return { text: controlCode(input) ?? input, consumed: true };
}
