import { createContext, useContext, type JSX } from "react";

import type { AttentionCounts } from "../lib/attention";

const PILL = "min-w-4 px-1 h-4 rounded-full text-[10px] leading-4 text-center";

export const FinishedKeysContext = createContext<ReadonlySet<string>>(new Set());

export function AttentionBadges({ counts, scope }: { readonly counts: AttentionCounts; readonly scope: string }): JSX.Element {
  const where = scope === "" ? "" : ` ${scope}`;
  return (
    <>
      {counts.blocked > 0 && <span className={`${PILL} bg-destructive text-destructive-foreground`} title={`${String(counts.blocked)} blocked${where}`}>{counts.blocked}</span>}
      {counts.finished > 0 && <span className={`${PILL} bg-success text-success-foreground`} title={`${String(counts.finished)} finished${where}`}>✓{counts.finished}</span>}
    </>
  );
}

export function FinishedMark({ sessionKey }: { readonly sessionKey: string }): JSX.Element | null {
  if (!useContext(FinishedKeysContext).has(sessionKey)) return null;
  return <span className="text-success shrink-0" title="Finished — not opened yet">✓</span>;
}
