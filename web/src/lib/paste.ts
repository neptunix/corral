// Bracketed-paste (DECSET 2004) encoding for everything corral injects into a pane.
// The markers are module-private: every producer that needs them lives in this file, so they are
// not part of the public surface.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Bytes to inject into the pane for the given absolute path(s). Wrapped in bracketed-paste markers so
 * Claude Code treats them as a paste (not typed input): this (a) mirrors a real drop/paste, (b) keeps
 * a leading "/" from triggering the slash-command menu, and (c) keeps each path one unit regardless of
 * surrounding whitespace. UTF-8 encoded because the PTY bridge reads binary frames as raw keystrokes.
 *
 * Each path — INCLUDING THE LAST — is terminated by a space INSIDE the paste block. Claude detects an
 * image path only when it is whitespace-delimited; a trailing space placed after the paste-end marker
 * leaves the final path butting against the marker, so it stays raw (only every earlier path attaches).
 * The space must sit before PASTE_END, one per path.
 */
export function formatDropInjection(paths: readonly string[]): Uint8Array {
  const block = paths.map((p) => `${p} `).join("");
  return new TextEncoder().encode(`${PASTE_START}${block}${PASTE_END}`);
}

// Both markers are the same length, so one length check covers either.
const MARKER_LEN = PASTE_START.length;

/** True if the last MARKER_LEN entries of buf spell out marker. */
function endsWithMarker(buf: readonly string[], marker: string): boolean {
  if (buf.length < MARKER_LEN) return false;
  for (let i = 0; i < MARKER_LEN; i++) {
    if (buf[buf.length - MARKER_LEN + i] !== marker[i]) return false;
  }
  return true;
}

/**
 * Strips embedded PASTE_START/PASTE_END markers so the block formatPaste wraps around them always
 * holds exactly one start and one end. A clipboard carrying a literal ESC[201~ would otherwise close
 * the block early and let the tail be typed raw — reproducing the very premature-submit bug this
 * module exists to prevent, and steerable by whatever wrote the clipboard. The fidelity cost
 * (pasting a transcript that legitimately contains markers loses them) is the accepted trade.
 *
 * A single left-to-right pass is enough, but only if a match is detected the instant it completes:
 * deleting one marker can splice its neighbours into a NEW one. E.g. "\x1b[20" + "\x1b[201~" + "0~" —
 * a real END straddled by a split START — has its END removed first, leaving "\x1b[20" butted against
 * "0~", which reads as a fresh START ("\x1b[200~"). Checking the tail of the output-so-far after every
 * appended character catches that: a marker can only ever COMPLETE at the tail, so this check is a
 * fixed point by construction — there is no way for a marker to form anywhere else, in front of or
 * behind, that this scan wouldn't already have seen. That makes it O(n) instead of the O(n²) of a
 * do/while that re-scans the whole string per pass (a crafted input can force ~n passes; a few hundred
 * KB of it hangs the main thread for tens of seconds — see the regression test below).
 *
 * The accumulator MUST be an array, not a string built with `+=`. `out.endsWith(marker)` on a string
 * built that way forces a flatten of the whole rope on every character, silently reintroducing O(n²).
 */
function stripMarkers(text: string): string {
  const out: string[] = [];
  for (const ch of text) {
    // Iterates by code point, so a surrogate pair arrives as one entry — fine here, since both
    // markers are pure ASCII and a match is always MARKER_LEN single-char entries.
    out.push(ch);
    if (endsWithMarker(out, PASTE_START) || endsWithMarker(out, PASTE_END)) out.length -= MARKER_LEN;
  }
  return out.join("");
}

/**
 * Bytes for a clipboard paste. Corral brackets the paste itself rather than letting xterm do it:
 * `herdr agent attach` never forwards the pane's ESC[?2004h (measured), so
 * xterm's decPrivateModes.bracketedPasteMode is permanently false and its own Clipboard.ts:paste()
 * would send the text un-wrapped with every newline ALREADY rewritten to "\r" — read by Claude Code
 * as a run of Enters that submits mid-paste. Wrapping here makes the emulator's mode
 * belief irrelevant, so nothing herdr replays can silently undo the fix.
 */
export function formatPaste(text: string): Uint8Array {
  const body = stripMarkers(text).replace(/\r?\n/g, "\r"); // mirrors xterm's prepareTextForTerminal: a terminal delivers CR, not LF
  return new TextEncoder().encode(`${PASTE_START}${body}${PASTE_END}`);
}
