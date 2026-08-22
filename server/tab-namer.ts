import type { SessionRow } from "@shared/schema";

import { normalizeLinkName } from "./link-name.ts";

export interface RenameOp {
  readonly env: string;
  readonly tabId: string;
  readonly label: string;
}

/**
 * A pane's name as Claude's session registry has it — the pair `rebuild()` merges onto a SessionRow,
 * which the 60 s sweep cannot read off its own rows (those come from `perEnv`, before that merge).
 *
 * `userSet` is a BIT, not SessionRow's tri-state: "no registry record for this pane" and "a record
 * whose name Claude derived" are different facts but the same decision here, so the accessor collapses
 * both to false rather than making every reader re-learn that they are equivalent.
 */
export interface ClaudeNameRef {
  readonly name: string | null;
  readonly userSet: boolean;
}

/**
 * Decide which herdr tabs should be renamed to match their Claude session name. Pure: given the live
 * rows and an accessor for each row's registry name, return the renames to apply.
 *
 * Rules:
 *  - group rows by tabId (rows with no tabId are ignored);
 *  - per tab the CANONICAL session is the row with the lexicographically smallest paneId — a documented
 *    proxy for "first pane" (herdr's agent list does not flag the root pane);
 *  - rename ONLY on `userSet`. False covers every not-the-operator's-choice case: no registry record
 *    for the pane, a name Claude derived for itself, or a record with no usable name.
 *  - emit a rename only when the NORMALIZED name is non-empty and differs from the current tab label.
 *
 * The name comes from the REGISTRY, not from the statusline capture. The capture is written only when
 * Claude renders its statusline — i.e. on activity — so for an idle session it can sit hours stale and
 * still hold the pre-rename name, which is exactly how a `/rename` used to go unnoticed here.
 *
 * Normalization runs BEFORE the already-matches compare. The other order would leave a name that
 * normalizes onto the current label differing from `tab` on every sweep, re-firing the same rename
 * forever — a redundant same-value CLI call each minute.
 */
export function computeRenames(
  rows: readonly SessionRow[],
  claudeNameFor: (row: SessionRow) => ClaudeNameRef,
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
    const ref = claudeNameFor(canonical);
    if (!ref.userSet || ref.name === null) continue; // only a name the operator chose
    const label = normalizeLinkName(ref.name);
    if (label === "") continue; // a whitespace- or control-only name normalizes away
    if (label === canonical.tab) continue; // already matches
    ops.push({ env: canonical.env, tabId, label });
  }
  return ops;
}
