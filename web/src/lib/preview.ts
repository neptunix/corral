// Maps a read-only pane snapshot (from GET /api/sessions/:env/:paneId/read) to the SessionCard
// `preview` prop for the Unassigned mini-terminal. `null` = the first read hasn't resolved yet, so
// show a placeholder rather than the "no output captured" copy; whitespace-only output is treated as
// genuinely empty. Kept pure (mirrors lib/attach.ts / lib/attention.ts) so vitest can pin it.
export function toSnapshotPreview(text: string | null): { text: string; captured: boolean } {
  if (text === null) return { text: "…", captured: true }; // loading placeholder
  if (text.trim() === "") return { text: "", captured: false };
  return { text, captured: true };
}
