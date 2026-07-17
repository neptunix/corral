import type { AccountUsage, RateWindow } from "@shared/schema";
import type { JSX } from "react";

import { usageLevelClass } from "../lib/level";
import { isStale, resetCountdown } from "../lib/time";

// "default_claude_max_20x" → "Max 20x"; "default_raven" → "Raven"; else the raw tier.
function tierLabel(tier: string | null): string {
  if (tier === null) return "";
  if (tier.includes("max_20x")) return "Max 20x";
  if (tier.includes("max_5x")) return "Max 5x";
  if (tier.includes("raven")) return "Raven";
  return tier.replace(/^default_/, "");
}

function Window({ label, w }: { readonly label: string; readonly w: RateWindow | null }): JSX.Element {
  if (w === null) return <span className="text-muted-foreground/60">{label} —</span>;
  const pct = Math.round(w.used_percentage);
  return (
    <span className="tabular-nums">
      <span className="text-muted-foreground/70">{label}</span>{" "}
      <span className={`font-semibold ${usageLevelClass(pct)}`}>{String(pct)}%</span>{" "}
      <span className="text-muted-foreground/50">({resetCountdown(w.resets_at)})</span>
    </span>
  );
}

export function UsageFooter({ accounts }: { readonly accounts: readonly AccountUsage[] }): JSX.Element | null {
  if (accounts.length === 0) return null;
  return (
    <footer className="shrink-0 border-t border-border bg-card/60 px-4 py-1 text-[11px] flex flex-col gap-0.5">
      {accounts.map((a) => {
        const stale = isStale(a.capturedAt);
        return (
          <div key={a.uuid} className={`flex items-center gap-3 ${stale ? "opacity-50" : ""}`}>
            <span className="text-foreground font-medium truncate max-w-[16rem]">{a.email ?? a.uuid}</span>
            {a.tier !== null && <span className="text-muted-foreground/70">{tierLabel(a.tier)}</span>}
            <Window label="5h" w={a.fiveHour} />
            <Window label="7d" w={a.sevenDay} />
            {stale && <span className="text-muted-foreground/50">◷</span>}
            <span className="text-muted-foreground/40 ml-auto">{a.envIds.join(" · ")}</span>
          </div>
        );
      })}
    </footer>
  );
}
