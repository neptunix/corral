// Level colors (green/amber/red), each with a `light:` override so they read on both the dark and
// light header/footer backgrounds (the unprefixed class is the dark-mode tone, `light:` is the
// darker light-mode tone — the same convention the rest of web/ uses).
const GREEN = "text-green-500 light:text-green-700";
const AMBER = "text-amber-500 light:text-amber-700";
const RED = "text-red-500 light:text-red-600";

// Rate-limit windows (5h/7d): the percent is budget CONSUMED over a long window, so it stays green
// well into it (green < 50, amber < 80, red ≥ 80) — matching the Claude statusline.
export function usageLevelClass(pct: number): string {
  if (pct < 50) return GREEN;
  if (pct < 80) return AMBER;
  return RED;
}

// Context-window fill warns earlier than a rate window: response quality and auto-compaction pressure
// climb well before the window is full (green < 35, amber < 50, red ≥ 50).
export function contextLevelClass(pct: number): string {
  if (pct < 35) return GREEN;
  if (pct < 50) return AMBER;
  return RED;
}
