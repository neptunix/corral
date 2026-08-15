import type { RecapSource, RecapStatus, StatuslineData } from "@shared/schema";
import type { JSX } from "react";

import { contextLevelClass } from "../lib/level";
import { isRecapStale, RECAP_SOURCE_LABEL, recapReason } from "../lib/recap-line";
import { isStale } from "../lib/time";

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
 * One tone per rung. Green is Claude reporting on its own work, blue a topic it invented for the
 * session, neutral your own last prompt — descending order of how much the line is worth trusting.
 * Amber is not here: a failed read overrides every rung (see `RecapBadge`).
 */
const TONE: Readonly<Record<RecapSource, string>> = {
  "away-summary": "border-green-500/40 text-green-500 light:text-green-700",
  "ai-title": "border-sky-500/40 text-sky-500 light:text-sky-700",
  "last-prompt": "border-muted-foreground/30 text-muted-foreground",
};

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
  // No rung to name means the only reason this badge renders at all is the failed read.
  const tone = stale || source === null
    ? "border-amber-500/60 text-amber-500 light:text-amber-700"
    : TONE[source];
  return (
    <span
      data-testid="recap-badge"
      // No vertical padding, and a line box sized to the row: the badge used to be ~22px tall against
      // 16px of text beside it and dragged the whole row to ~34px. The border tone is muted-foreground,
      // not `border-border` — that token is a hairline for dividing FILLED surfaces, and this badge sits
      // on a translucent panel where it disappears, which is most of the fleet (topic and prompt).
      className={`shrink-0 rounded border px-1 text-[10px] leading-[15px] uppercase ${tone}`}
      title={stale
        ? `${recapReason(status)} — showing the last recap that was read`
        : source === null ? undefined : RECAP_SOURCE_LABEL[source].hint}
    >
      {stale ? `${label} ⚠`.trim() : label}
    </span>
  );
}

/**
 * The two facts above a session's terminal: what the session is costing, and what it is doing.
 *
 * They share ONE line from the `sm` breakpoint up and stack below it. On a shared line the metrics
 * are the side that gives way — every one of them is also in the fleet row and the board card, while
 * the recap is written nowhere else, so the field with a second home is the field that truncates.
 *
 * That order is bought by the recap's `sm:min-w-[14em]` floor, and ONLY by it. `flex-1` is
 * `flex: 1 1 0%`: a zero base size means the recap absorbs none of a row's shortage, so without the
 * floor it would be squeezed to nothing while the metrics still sat at full width — the exact
 * reverse of the sentence above. The floor freezes the recap first and hands the shortage to the
 * metrics, which then truncate toward their own 7em floor. Do not remove either floor casually.
 *
 * The row aligns on CENTRE, not baseline: `truncate` makes the metrics span a scroll container, and
 * a scroll container has no baseline to share — one is synthesised from its bottom edge, which would
 * lift the metrics a descender above the recap beside them.
 *
 * Both halves render unconditionally: the block used to appear only once data arrived, so the first
 * capture inserted a row and shoved the terminal down on every open.
 */
export function SessionMeta({ statusline, recap, recapStatus, recapSource }: {
  readonly statusline: StatuslineData | null;
  readonly recap: string | null;
  readonly recapStatus: RecapStatus | null;
  readonly recapSource: RecapSource | null;
}): JSX.Element {
  const stale = isRecapStale(recapStatus, recap !== null && recap !== "");
  return (
    <div className="flex flex-col gap-0.5 px-4 py-1.5 border-b border-border shrink-0 text-[11px] sm:flex-row sm:items-center sm:gap-2">
      <span
        className={`font-mono tabular-nums truncate text-muted-foreground min-w-0 sm:min-w-[7em] ${
          statusline !== null && isStale(statusline.captured_at) ? "opacity-50" : ""}`}
      >
        {statusline !== null
          ? <MetricChips sl={statusline} />
          : <span className="text-muted-foreground/40">metrics not read yet</span>}
      </span>
      {/* Same tone as the badge's border, and for the same reason: `border-border` divides filled
          surfaces and vanishes on the translucent panel this row sits on. */}
      <span className="hidden w-px self-stretch bg-muted-foreground/30 sm:block" />
      {recap !== null && recap !== "" ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden sm:min-w-[14em]">
          <RecapBadge source={recapSource} stale={stale} status={recapStatus} />
          {/* The retained text stays — it is still the best there is — but dimmed, so a stale line
              cannot be mistaken for a fresh one at a glance.

              Below `sm` the tail scrolls instead of being clipped: `title` is a hover affordance, and
              a finger cannot hover, so on a phone the end of a long recap is otherwise unreachable.
              From `sm` up it goes back to clip-and-tooltip — with a pointer the whole text is one
              hover away, which beats having to drag it. `overscroll-x-contain` keeps a swipe that
              runs off the end of the text from scrolling the page under it, and the scrollbar is
              hidden because on the platforms that reserve space for one it would add back the row
              height this change just removed. */}
          <span
            className={`no-scrollbar min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain whitespace-nowrap sm:overflow-hidden sm:text-ellipsis ${
              stale ? "text-muted-foreground/50" : "text-muted-foreground"}`}
            title={recap}
          >
            {recap}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-muted-foreground/40">{recapReason(recapStatus)}</span>
      )}
    </div>
  );
}
