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
 *  - only a USER-SET name renames (name_source present and !== "derived") — never an auto title;
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
    const source = sl.name_source;
    if (source === null || source === "derived") continue; // only user-set names
    const name = sl.session_name;
    if (name === null || name === "") continue;
    if (name === canonical.tab) continue; // already matches
    ops.push({ env: canonical.env, tabId, label: name });
  }
  return ops;
}
