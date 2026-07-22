import type { SessionRow, StatuslineData } from "@shared/schema";

export interface RenameOp {
  readonly env: string;
  readonly tabId: string;
  readonly label: string;
}

/**
 * Decide which herdr tabs should be renamed to match their Claude session name. Pure: given the live
 * rows and an accessor for each row's cached statusline, return the renames to apply.
 *
 * Rules (see design 2026-07-22):
 *  - group rows by tabId (rows with no tabId are ignored);
 *  - per tab the CANONICAL session is the row with the lexicographically smallest paneId — a documented
 *    proxy for "first pane" (herdr's agent list does not flag the root pane);
 *  - skip only AUTO-DERIVED names (name_source === "derived"); a user-set name renames. Note: in the
 *    current Claude Code version `/rename` sets `.name` but leaves `nameSource` ABSENT (captured as
 *    null), while auto names carry `nameSource: "derived"` — so null/absent means user-set and MUST
 *    rename (this mirrors the retired herdr-tab-sync hook, which skipped iff `nameSource == "derived"`);
 *  - emit a rename only when the name is non-empty AND differs from the current tab label.
 */
export function computeRenames(
  rows: readonly SessionRow[],
  statuslineFor: (row: SessionRow) => StatuslineData | null,
): RenameOp[] {
  const byTab = new Map<string, SessionRow[]>();
  for (const r of rows) {
    if (r.tabId === undefined || r.tabId === "") continue;
    const group = byTab.get(r.tabId) ?? [];
    group.push(r);
    byTab.set(r.tabId, group);
  }

  const ops: RenameOp[] = [];
  for (const [tabId, group] of byTab) {
    const canonical = [...group].sort((a, b) => a.paneId.localeCompare(b.paneId))[0];
    if (canonical === undefined) continue;
    const sl = statuslineFor(canonical);
    if (sl === null) continue;
    if (sl.name_source === "derived") continue; // skip auto-derived only; null/absent = user-set → rename
    const name = sl.session_name;
    if (name === null || name === "") continue;
    if (name === canonical.tab) continue; // already matches
    ops.push({ env: canonical.env, tabId, label: name });
  }
  return ops;
}
