import type { Board } from "@shared/board-schema";
import type { DiagnosticsSnapshot } from "@shared/diagnostics-schema";
import { computeRollup, emptyDiagnostics } from "@shared/diagnostics-schema";
import type { AttentionMap, EnvState } from "@shared/schema";
import { useEffect, useRef, useState, type JSX } from "react";

import { AttentionFeed } from "./AttentionFeed";
import { HealthPanel } from "./HealthPanel";
import { boardAttention } from "../lib/attention";
import { badgeCount, pickSnapshot, renderedChecks } from "../lib/diagnostics-view";
import { envLabel } from "../lib/env";

type Open = "none" | "attention" | "health";

interface Props {
  /** `null` means no carrier — no frame and no seed, as on a board switch. Not "nothing is wrong". */
  readonly diagnostics: DiagnosticsSnapshot | null;
  readonly streamDown: boolean;
  readonly attention: AttentionMap;
  readonly boards: readonly Board[];
  readonly envs: Readonly<Record<string, EnvState>>;
  readonly activeBoardId: string | null;
  readonly showUnassigned: boolean;
  readonly onOpen: (env: string, paneId: string) => void;
}

function healthPhrase(count: number, info: number): string {
  if (count === 1) return "1 problem";
  if (count > 1) return `${String(count)} problems`;
  if (info === 1) return "1 recommendation";
  if (info > 1) return `${String(info)} recommendations`;
  return "OK";
}

/**
 * Owns the right-hand side: the icon strip, WHICH panel is open, and the one snapshot slot.
 *
 * One `open` variable rather than a flag per panel — two flags would allow both panels at once and
 * there is room for one. One snapshot slot rather than a streamed value plus a Recheck override —
 * the digit and the rows it summarizes must be the same value by construction.
 */
export function SideRail({
  diagnostics, streamDown, attention, boards, envs, activeBoardId, showUnassigned, onOpen,
}: Props): JSX.Element {
  const [open, setOpen] = useState<Open>("none");
  const [held, setHeld] = useState<DiagnosticsSnapshot>(emptyDiagnostics());
  const [announcement, setAnnouncement] = useState("");
  // Consumed by the auto-open itself and by the operator touching the HEALTH button. Deliberately NOT
  // by the bell: every load starts collapsed, so the first click is often the bell, and consuming the
  // latch there would disable the health auto-open for the whole session.
  const autoOpenSpent = useRef(false);
  // Held so group labels do not degrade to raw env ids during the board-switch gap that empties `envs`.
  const heldEnvs = useRef<Readonly<Record<string, EnvState>>>({});
  if (Object.keys(envs).length > 0) heldEnvs.current = envs;

  useEffect(() => { setHeld((cur) => pickSnapshot(cur, diagnostics)); }, [diagnostics]);

  const rollup = computeRollup(renderedChecks(held, streamDown));
  const count = badgeCount(rollup);

  useEffect(() => {
    // The latch is spent only on the branch that actually opens: a problem arriving while the bell is
    // open must not forfeit the auto-open for the rest of the page's life.
    if (autoOpenSpent.current || count === 0 || open !== "none") return;
    autoOpenSpent.current = true;
    setOpen("health");
    setAnnouncement(`System health opened: ${healthPhrase(count, rollup.info)}`);
  }, [count, rollup.info, open]);

  const boardScoped = !showUnassigned && activeBoardId !== null;
  const entries = boardScoped ? boardAttention(attention, boards, activeBoardId) : [];
  // Pure derivation, not an effect: no render may contain a panel scoped to a board that is not shown.
  const shown: Open = open === "attention" && !boardScoped ? "none" : open;

  const toggle = (panel: Open): void => {
    if (panel === "health") autoOpenSpent.current = true;
    setOpen((cur) => (cur === panel ? "none" : panel));
  };

  return (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      {shown === "attention" && (
        <AttentionFeed entries={entries} envs={heldEnvs.current} onOpen={onOpen}
                       onClose={() => { setOpen("none"); }} />
      )}
      {shown === "health" && (
        <HealthPanel snapshot={held} streamDown={streamDown}
                     labelFor={(id) => envLabel(heldEnvs.current, id)}
                     onClose={() => { setOpen("none"); }} onSnapshot={setHeld} />
      )}
      <div className="shrink-0 w-12 border-l border-border flex flex-col items-center pt-3 gap-3">
        {boardScoped && (
          <button type="button" onClick={() => { toggle("attention"); }}
                  aria-expanded={shown === "attention"} aria-controls="attention-panel"
                  className="relative text-muted-foreground hover:text-foreground"
                  aria-label={entries.length > 0
                    ? `Sessions needing attention: ${String(entries.length)}`
                    : "Sessions needing attention: none"}>
            <span className="text-lg" aria-hidden>🔔</span>
            {entries.length > 0 && (
              <span aria-hidden className="absolute -top-1 -right-2 min-w-4 px-1 h-4 rounded-full bg-destructive text-destructive-foreground text-[10px] leading-4 text-center">
                {entries.length}
              </span>
            )}
          </button>
        )}
        <button type="button" onClick={() => { toggle("health"); }}
                aria-expanded={shown === "health"} aria-controls="health-panel"
                className="relative text-muted-foreground hover:text-foreground"
                aria-label={`System health: ${healthPhrase(count, rollup.info)}`}>
          <span className="text-lg" aria-hidden>🛟</span>
          {count > 0 && (
            <span aria-hidden className="absolute -top-1 -right-2 min-w-4 px-1 h-4 rounded-full bg-destructive text-destructive-foreground text-[10px] leading-4 text-center">
              {count}
            </span>
          )}
          {count === 0 && rollup.info > 0 && (
            <span aria-hidden className="absolute -top-0 -right-1 w-2 h-2 rounded-full bg-muted-foreground" />
          )}
        </button>
      </div>
    </>
  );
}
