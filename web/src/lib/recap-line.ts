import type { RecapSource, RecapStatus } from "@shared/schema";

/**
 * What the recap line prints when it has no text. Every RecapStatus gets its OWN words: carrying the
 * status to the web is only worth anything if "nothing to show" and "the read is broken" stop looking
 * alike — an unexplained blank line is how a dead recap source hid for a month
 * (docs/adr/0005).
 *
 * `null` is its own case, not an error: no sweep has touched this pane yet.
 */
export function recapReason(status: RecapStatus | null): string {
  switch (status) {
    // "ok" with no text should not occur (away_summary content is never blank, and the ladder skips
    // blank rungs), but it must still read as an empty recap rather than as a failure.
    case "ok":
    case "no-summary": return "no recap yet";
    case "no-session-ref": return "no Claude session on this pane";
    case "not-found": return "transcript not found";
    case "read-error": return "recap read failed";
    case null: return "recap not read yet";
  }
}

/**
 * True when the recap on screen is older than the last read of it. The cache keeps the last good text
 * when a read fails and refreshes only the status (`server/recap.ts`), so any status other than `ok`
 * means what is shown is NOT what the last sweep saw. Without this the failure only ever surfaces on
 * sessions that never had a recap — a broken read on a session that did looks perfectly healthy, which
 * is the same asymmetry `recapReason` exists to remove.
 *
 * `null` is not staleness: the pane has simply not been swept yet, so no text can be on screen either.
 */
export function isRecapStale(status: RecapStatus | null, hasText: boolean): boolean {
  return hasText && status !== null && status !== "ok";
}

/**
 * One muted word naming the recap's provenance, in the same vocabulary as the MCP fleet row, plus the
 * difference that actually matters: only `away-summary` is Claude describing its own work.
 */
export const RECAP_SOURCE_LABEL: Readonly<Record<RecapSource, { readonly tag: string; readonly hint: string }>> = {
  "away-summary": { tag: "recap", hint: "Claude's own recap of what it is doing" },
  "ai-title": { tag: "topic", hint: "the topic Claude generated for this session — not a report on its work" },
  "last-prompt": { tag: "prompt", hint: "your last prompt to this session — Claude has written no recap yet" },
};
