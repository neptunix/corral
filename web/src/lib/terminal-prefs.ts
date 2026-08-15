import { z } from "zod";

// Scroll speed for the session terminal, kept PER DEVICE in localStorage rather than server-side:
// a trackpad and a phone want different multipliers, and per-device storage gives that split without
// corral having to detect a device class at all. Same untrusted-boundary rules as spawn-prefs.ts —
// another tab, an older build, or a hand-edited value can put anything under this key.
const KEY = "corral.terminal.prefs";

export const SCROLL_SPEED_MIN = 1;
export const SCROLL_SPEED_MAX = 10;
export const SCROLL_SPEED_DEFAULT = 3;

// xterm THROWS on scrollSensitivity <= 0, so clamping is a crash guard, not cosmetics.
export function clampScrollSpeed(value: number): number {
  if (!Number.isFinite(value)) return SCROLL_SPEED_DEFAULT;
  return Math.min(SCROLL_SPEED_MAX, Math.max(SCROLL_SPEED_MIN, value));
}

const terminalPrefsSchema = z.object({
  scrollSpeed: z.number().catch(SCROLL_SPEED_DEFAULT).transform(clampScrollSpeed),
});

export type TerminalPrefs = z.infer<typeof terminalPrefsSchema>;

function defaults(): TerminalPrefs {
  return { scrollSpeed: SCROLL_SPEED_DEFAULT };
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

export function writeTerminalPrefs(next: TerminalPrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota or denied storage — dropping the preference is the correct degradation.
  }
}
