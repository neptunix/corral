import type { LogEntry, LogSource } from "@shared/board-schema";

export type LogFilter = "all" | "notes" | "lifecycle";

// `note` is the one kind a session writes; every other kind is corral's lifecycle stamp.
export function filterLog(log: readonly LogEntry[], filter: LogFilter): LogEntry[] {
  if (filter === "all") return [...log];
  return log.filter((e) => (e.kind === "note") === (filter === "notes"));
}

export function logCounts(all: readonly LogEntry[], shown: readonly LogEntry[]): { readonly headline: string; readonly detail: string } {
  const notes = all.filter((e) => e.kind === "note").length;
  const system = all.length - notes;
  const detail = `${String(notes)} ${notes === 1 ? "note" : "notes"} · ${String(system)} lifecycle`;
  if (all.length === 0) return { headline: "no entries yet", detail };
  const total = `${String(all.length)} ${all.length === 1 ? "entry" : "entries"}`;
  return { headline: shown.length === all.length ? total : `${String(shown.length)} of ${total}`, detail };
}

export interface DayGroup {
  readonly label: string;
  readonly entries: readonly LogEntry[];
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getFullYear())}-${String(d.getMonth())}-${String(d.getDate())}`;
}

function dayLabel(ms: number, now: number): string {
  const key = localDayKey(ms);
  if (key === localDayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1); // calendar day, not 24h — a DST day is 23 or 25 hours
  if (key === localDayKey(yesterday.getTime())) return "Yesterday";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

// Newest first throughout — days and the entries inside them — so what just landed is at the top,
// where the badge's "N new" points. Sorted (stably) by atMs before grouping so a file whose order
// disagrees with its timestamps cannot split one day into two groups.
export function groupByDay(log: readonly LogEntry[], now: number = Date.now()): DayGroup[] {
  const sorted = [...log].sort((a, b) => a.atMs - b.atMs).reverse();
  const groups: { label: string; key: string; entries: LogEntry[] }[] = [];
  for (const e of sorted) {
    const key = localDayKey(e.atMs);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.entries.push(e);
    else groups.push({ label: dayLabel(e.atMs, now), key, entries: [e] });
  }
  return groups.map(({ label, entries }) => ({ label, entries }));
}

export function entryTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function sourceName(source: LogSource): string {
  return typeof source === "string" ? source : source.name;
}
