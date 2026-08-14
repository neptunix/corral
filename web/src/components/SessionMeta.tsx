import type { RecapSource, RecapStatus, StatuslineData } from "@shared/schema";
import type { JSX } from "react";

import { contextLevelClass } from "../lib/level";
import { isRecapStale, RECAP_SOURCE_LABEL, recapReason } from "../lib/recap-line";
import { isStale } from "../lib/time";

/**
 * The two facts above a session's terminal: what the session is costing, and what it is doing.
 *
 * They share ONE line from the `sm` breakpoint up and stack below it. On a shared line the metrics
 * are the side that gives way — every one of them is also in the fleet row and the board card, while
 * the recap is written nowhere else, so the field with a second home is the field that truncates.
 * Both rows render unconditionally: the block used to appear only once data arrived, so the first
 * capture inserted a row and shoved the terminal down on every open.
 */
// Renders the statusline's second-line chips: model · ctx NN% (NNK) · $X.XX · +A/−R. Any field null →
// its chip is omitted entirely (not "· —"), so a partial capture still reads clean. The ctx% is
// color-coded by level (green/amber/red) via contextLevelClass — which warns earlier than the 5h/7d
// windows since context degrades before it's full; everything else stays muted (parent span).
function MetricChips({ sl }: { readonly sl: StatuslineData }): JSX.Element {
  const chips: JSX.Element[] = [];
  if (sl.model !== null) chips.push(<span key="model">{sl.model}</span>);
  if (sl.ctx.pct !== null) {
    const pct = sl.ctx.pct;
    chips.push(
      <span key="ctx">
        ctx <span className={`font-semibold ${contextLevelClass(pct)}`}>{`${String(pct)}%`}</span>
        {sl.ctx.tokens !== null ? ` (${String(Math.round(sl.ctx.tokens / 1000))}K)` : ""}
      </span>,
    );
  }
  if (sl.cost.usd !== null) chips.push(<span key="cost">{`$${sl.cost.usd.toFixed(2)}`}</span>);
  if (sl.cost.lines_added !== null || sl.cost.lines_removed !== null) {
    chips.push(<span key="lines">{`+${String(sl.cost.lines_added ?? 0)}/−${String(sl.cost.lines_removed ?? 0)}`}</span>);
  }
  return (
    <>
      {chips.flatMap((chip, i) =>
        i === 0
          ? [chip]
          : [<span key={`sep-${String(chip.key)}`} className="text-muted-foreground/40"> · </span>, chip],
      )}
    </>
  );
}

/**
 * Which rung of the ladder produced the recap, and whether the last read of it failed.
 *
 * A badge rather than a bare word: sharing a line with the metrics puts the tag mid-sentence, where
 * a plain word reads as the first word of the recap instead of a label on it.
 *
 * It carries the failed-read signal for a structural reason. That signal used to be appended after
 * the text, which works on a row of its own and silently fails on a shared one — a suffix truncates
 * away exactly when the text is long enough to push it out, so the warning would vanish precisely
 * where it is needed. The badge sits on the side of the row that never shrinks.
 */
function RecapBadge({ source, stale, status }: {
  readonly source: RecapSource | null;
  readonly stale: boolean;
  readonly status: RecapStatus | null;
}): JSX.Element | null {
  if (source === null && !stale) return null;
  const label = source === null ? "" : RECAP_SOURCE_LABEL[source].tag;
  const tone = stale
    ? "border-amber-500/60 text-amber-500 light:text-amber-700"
    // Only the top rung is Claude reporting on its own work; a topic or your own last prompt is a
    // stand-in for one. Worth a glance's difference, not a colour of its own.
    : source === "away-summary"
      ? "border-green-500/40 text-green-500 light:text-green-700"
      : "border-muted-foreground/30 text-muted-foreground/70";
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 text-[9px] font-semibold uppercase leading-[15px] tracking-wide ${tone}`}
      title={stale
        ? `${recapReason(status)} — showing the last recap that was read`
        : source === null ? undefined : RECAP_SOURCE_LABEL[source].hint}
    >
      {stale ? `${label} ⚠`.trim() : label}
    </span>
  );
}

export function SessionMeta({ statusline, recap, recapStatus, recapSource }: {
  readonly statusline: StatuslineData | null;
  readonly recap: string | null;
  readonly recapStatus: RecapStatus | null;
  readonly recapSource: RecapSource | null;
}): JSX.Element {
  const stale = isRecapStale(recapStatus, recap !== null && recap !== "");
  return (
    <div className="flex flex-col gap-0.5 px-4 py-1.5 border-b border-border shrink-0 text-[11px] sm:flex-row sm:items-baseline sm:gap-2">
      <span
        className={`font-mono tabular-nums truncate text-muted-foreground min-w-0 sm:min-w-[7em] ${
          statusline !== null && isStale(statusline.captured_at) ? "opacity-50" : ""}`}
      >
        {statusline !== null
          ? <MetricChips sl={statusline} />
          : <span className="text-muted-foreground/40">metrics not read yet</span>}
      </span>
      <span className="hidden w-px self-stretch bg-border sm:block" />
      {recap !== null && recap !== "" ? (
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <RecapBadge source={recapSource} stale={stale} status={recapStatus} />
          {/* The retained text stays — it is still the best there is — but dimmed, so a stale line
              cannot be mistaken for a fresh one at a glance. */}
          <span className={`truncate ${stale ? "text-muted-foreground/50" : "text-muted-foreground/80"}`} title={recap}>
            {recap}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-muted-foreground/40">{recapReason(recapStatus)}</span>
      )}
    </div>
  );
}
