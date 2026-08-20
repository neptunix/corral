import { stripControl } from "./restore-format.ts";
import { NAME_MAX } from "./spawn.ts";

// The name a SessionLink carries once it mirrors the live Claude session's, normalized at the one
// boundary it crosses. It lives here rather than in spawn.ts because nothing about it is a spawn:
// the value comes from Claude's registry and the only writer is the reconciler.

// Hoisted: the reconciler's pre-scan calls this for every named link on every snapshot.
const NAME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The boundary guard on a name copied from Claude's registry onto a SessionLink. Deliberately does
 * NOT slugify: the card shows what Claude shows, so "Fix the auth bug" stays as typed. That drops the
 * NAME_RE guarantee a spawn-created link used to carry — the two paths deriving from link.name
 * slugify for themselves (server/api.ts, resume and spawn uniqueness), and a future reader assuming
 * NAME_RE must do the same.
 *
 * stripControl is REUSED, not re-rolled: it handles CSI, OSC with both BEL and ST terminators,
 * unterminated OSC and C1 introducers, where a /[\x00-\x1F]/g eats only the ESC byte and leaves the
 * parameters behind. Control characters and escape sequences ONLY — bidi overrides and zero-width
 * marks are legal text and survive, here as on every surface this name reaches.
 *
 * The cap counts GRAPHEMES, so NAME_MAX no longer bounds `.length`; consumers needing a hard bound
 * re-slice for themselves (server/api.ts). Every other name here has been through slugify, which is
 * ASCII, so a UTF-16 slice could never split a character — an arbitrary Claude name can, and code
 * points would still cut a flag or a ZWJ sequence in half.
 */
export function normalizeLinkName(text: string): string {
  const clean = stripControl(text).trim();
  if (clean.length <= NAME_MAX) return clean; // NAME_MAX UTF-16 units is never more than NAME_MAX graphemes
  let out = "";
  let n = 0;
  for (const { segment } of NAME_SEGMENTER.segment(clean)) {
    if (++n > NAME_MAX) break;
    out += segment;
  }
  // A cut landing after a space would store the trailing whitespace the leading trim exists to
  // remove. It cannot empty the string: clean[0] is already non-whitespace.
  return out.trimEnd();
}
