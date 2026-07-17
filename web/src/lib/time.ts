export function relativeTime(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${String(s)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h ago`;
  return `${String(Math.floor(h / 24))}d ago`;
}

// resetsAt is a Unix epoch in SECONDS (Claude rate_limits.*.resets_at). Renders the time remaining
// as "Nd Nh" (>= 1 day) or "Nh Nm" (< 1 day). Past / null → "—". Mirrors the statusline script.
export function resetCountdown(resetsAtEpochSec: number | null, now: number = Date.now()): string {
  if (resetsAtEpochSec === null) return "—";
  const diffSec = Math.floor(resetsAtEpochSec - now / 1000);
  if (diffSec <= 0) return "—";
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  return days > 0 ? `${String(days)}d${String(hours)}h` : `${String(hours)}h${String(mins)}m`;
}

// capturedAt is a Unix epoch in SECONDS (StatuslineData.captured_at). A statusline only refreshes
// while its session is actively rendering, so an old capture means the metrics are stale. 5 min:
// forgiving enough that a briefly-idle live session (refreshes ~every 60s) doesn't flicker to dim,
// while still flagging an account/session with no active capture. Applies to both the usage footer
// and the terminal-header chips (shared default).
export function isStale(capturedAtEpochSec: number, now: number = Date.now(), thresholdMs = 300000): boolean {
  return now - capturedAtEpochSec * 1000 > thresholdMs;
}
