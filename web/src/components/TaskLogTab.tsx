import type { LogEntry } from "@shared/board-schema";
import { LOG_NOTE_QUOTA, LOG_SYSTEM_QUOTA } from "@shared/board-schema";
import type { JSX } from "react";
import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { markLogSeen, seenKey } from "../lib/log-seen";
import type { LogFilter } from "../lib/log-view";
import { entryTime, filterLog, groupByDay, logCounts, sourceName } from "../lib/log-view";

interface Props {
  readonly boardId: string;
  readonly taskId: string;
  // The frame's counters for this card. They move when a session appends while the tab is open,
  // and the tab refetches on that — otherwise the badge behind the modal says "new" and the open
  // tab cannot show it.
  readonly logCount: number;
  readonly lastLogAtMs: number | null;
}

type Load =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly log: readonly LogEntry[] };

const FILTERS: readonly { readonly id: LogFilter; readonly label: string }[] = [
  { id: "all", label: "All" }, { id: "notes", label: "Notes" }, { id: "lifecycle", label: "Lifecycle" },
];

/**
 * The card's log, read from the one route that carries it. Every entry's text was written by another
 * session and is rendered as text only — the same treatment a recap gets — never as markup.
 *
 * Displaying the log is what marks it seen (log-seen.ts): the badge on the board counts from what
 * this tab last showed, so the mark is taken from the fetched entries rather than the frame's
 * counters, which can lag the fetch.
 */
export function TaskLogTab({ boardId, taskId, logCount, lastLogAtMs }: Props): JSX.Element {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [filter, setFilter] = useState<LogFilter>("all");

  useEffect(() => {
    let cancelled = false;
    api.boards.get(boardId)
      .then((board) => {
        if (cancelled) return;
        const task = board.tasks.find((t) => t.id === taskId);
        if (task === undefined) { setLoad({ state: "error", message: "This card is no longer on this board." }); return; }
        markLogSeen(seenKey(boardId, taskId), {
          count: task.log.length,
          atMs: task.log.reduce((max, e) => Math.max(max, e.atMs), 0),
        });
        setLoad({ state: "ready", log: task.log });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoad({ state: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [boardId, taskId, logCount, lastLogAtMs]);

  const all = load.state === "ready" ? load.log : [];
  const shown = filterLog(all, filter);
  const counts = logCounts(all, shown);
  const groups = groupByDay(shown);

  return (
    <div role="tabpanel">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground min-w-0">
          <span>{load.state === "ready" ? counts.headline : load.state === "loading" ? "loading…" : "log not read"}</span>
          {load.state === "ready" && all.length > 0 && <span className="text-muted-foreground/60">{counts.detail}</span>}
        </div>
        <div className="flex gap-2 shrink-0" role="group" aria-label="Filter log">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => { setFilter(f.id); }}
              className={`px-3 py-1 rounded text-xs ${filter === f.id ? "bg-primary text-primary-foreground font-semibold" : "bg-muted text-muted-foreground hover:text-foreground"}`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-background border border-border rounded-md h-[min(372px,50vh)] overflow-y-auto">
        {load.state === "error" && <p className="p-3.5 text-xs text-destructive">{load.message}</p>}
        {load.state === "ready" && all.length === 0 && (
          <p className="p-3.5 text-xs text-muted-foreground/60">Nothing written yet.</p>
        )}
        {load.state === "ready" && all.length > 0 && shown.length === 0 && (
          <p className="p-3.5 text-xs text-muted-foreground/60">No {filter === "notes" ? "notes" : "lifecycle entries"}.</p>
        )}
        {groups.map((g) => (
          <div key={g.label}>
            <div className="sticky top-0 bg-background px-3.5 pt-2.5 pb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground/65">{g.label}</div>
            {g.entries.map((e) => <EntryRow key={e.id} entry={e} />)}
          </div>
        ))}
        {load.state === "ready" && all.length > 0 && (
          <div className="px-3.5 pt-2.5 pb-3.5 pl-[66px] text-[11px] text-muted-foreground/45">
            Older entries are evicted per quota — {LOG_NOTE_QUOTA} notes, {LOG_SYSTEM_QUOTA} lifecycle.
          </div>
        )}
      </div>
      <p className="mt-2.5 text-[11px] leading-4 text-muted-foreground/70">
        Entries are appended, never edited. Sessions write notes; corral writes the lifecycle.
      </p>
    </div>
  );
}

function EntryRow({ entry }: { readonly entry: LogEntry }): JSX.Element {
  const system = entry.kind !== "note";
  return (
    <div className="flex gap-3 px-3.5 py-[7px] items-start" data-testid="log-entry" data-kind={entry.kind}>
      <span className="w-[38px] shrink-0 font-mono text-[11px] leading-[18px] text-muted-foreground/55">{entryTime(entry.atMs)}</span>
      <span className={`shrink-0 mt-1.5 w-[7px] h-[7px] rounded-full ${system ? "border border-border" : "bg-primary"}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={`text-xs leading-[18px] ${system ? "text-muted-foreground/70" : "text-primary font-semibold"}`}>{sourceName(entry.source)}</span>
          {system && <span className="font-mono text-[10px] text-muted-foreground/50">{entry.kind}</span>}
        </div>
        {/* pre-wrap keeps an entry's own line breaks; break-words stops one long token widening the modal. */}
        <div className={`text-[13px] leading-[19px] mt-px whitespace-pre-wrap break-words ${system ? "text-muted-foreground/75" : "text-foreground"}`}>{entry.text}</div>
      </div>
    </div>
  );
}
