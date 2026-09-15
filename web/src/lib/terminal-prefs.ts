import { z } from "zod";

// Scroll speed for the session terminal, kept PER DEVICE in localStorage rather than server-side:
// a trackpad and a phone want different multipliers, and per-device storage gives that split without
// corral having to detect a device class at all. Same untrusted-boundary rules as spawn-prefs.ts —
// another tab, an older build, or a hand-edited value can put anything under this key.
const KEY = "corral.terminal.prefs";

export const SCROLL_SPEED_MIN = 1;
export const SCROLL_SPEED_MAX = 10;
export const SCROLL_SPEED_DEFAULT = 3;

// The speed is a COUNT — how many wheel events corral emits per real one (wheel-gain.ts) — so it is
// whole numbers only, and never below 1, which would mean swallowing scrolls outright.
export function clampScrollSpeed(value: number): number {
  if (!Number.isFinite(value)) return SCROLL_SPEED_DEFAULT;
  return Math.round(Math.min(SCROLL_SPEED_MAX, Math.max(SCROLL_SPEED_MIN, value)));
}

// `keyBarHidden` carries a `.default` and must keep it: this schema parses as one object, so a value
// stored by a build that predates the field would fail the whole parse and silently reset the scroll
// speed with it. The default is what lets old records through intact.
const terminalPrefsSchema = z.object({
  scrollSpeed: z.number().transform(clampScrollSpeed),
  keyBarHidden: z.boolean().default(false),
});

export type TerminalPrefs = z.infer<typeof terminalPrefsSchema>;

function defaults(): TerminalPrefs {
  return { scrollSpeed: SCROLL_SPEED_DEFAULT, keyBarHidden: false };
}

export function readTerminalPrefs(): TerminalPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return defaults();
    const parsed = terminalPrefsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : defaults();
  } catch {
    // Bad JSON, or a browser that denies storage access (private mode). A preference is never a
    // reason to break the terminal.
    return defaults();
  }
}

// A PATCH, merged over what is stored, not a whole record: with more than one field a writer that
// only cares about its own would otherwise have to restate the others, and forgetting one silently
// resets it to the default.
export function writeTerminalPrefs(next: Partial<TerminalPrefs>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...readTerminalPrefs(), ...next }));
  } catch {
    // Quota or denied storage — dropping the preference is the correct degradation.
  }
}
