import type { LogEntry } from "@shared/board-schema";
import { describe, expect, it } from "vitest";

import { entryTime, filterLog, groupByDay, logCounts, sourceName } from "../web/src/lib/log-view";

const NOON = Date.UTC(2026, 7, 25, 12, 0, 0); // 2026-08-25T12:00Z
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function entry(over: Partial<LogEntry> & { readonly id: string }): LogEntry {
  return { atMs: NOON, source: "corral", kind: "note", text: "…", ...over };
}

describe("filterLog", () => {
  const log = [
    entry({ id: "a", kind: "note" }),
    entry({ id: "b", kind: "session_spawned" }),
    entry({ id: "c", kind: "status_changed" }),
  ];
  it("notes-only keeps ONLY `note`, not every non-system-looking kind", () => {
    expect(filterLog(log, "notes").map((e) => e.id)).toEqual(["a"]);
  });
  it("lifecycle keeps everything but `note` — every system kind, not one of them", () => {
    expect(filterLog(log, "lifecycle").map((e) => e.id)).toEqual(["b", "c"]);
  });
  it("all keeps the log as it is", () => {
    expect(filterLog(log, "all")).toHaveLength(3);
  });
});

describe("logCounts", () => {
  it("counts notes and lifecycle from the WHOLE log, not the filtered view", () => {
    const log = [entry({ id: "a" }), entry({ id: "b", kind: "created" }), entry({ id: "c", kind: "session_closed" })];
    expect(logCounts(log, filterLog(log, "notes"))).toEqual({
      headline: "1 of 3 entries", detail: "1 note · 2 lifecycle",
    });
  });
  it("an unfiltered log does not read as a subset of itself", () => {
    const log = [entry({ id: "a" }), entry({ id: "b" })];
    expect(logCounts(log, log).headline).toBe("2 entries");
  });
  it("an empty log says so instead of \"0 of 0\"", () => {
    expect(logCounts([], []).headline).toBe("no entries yet");
  });
});

describe("groupByDay", () => {
  it("newest first throughout — days and the entries inside them, never ascending within a day", () => {
    const log = [
      entry({ id: "y1", atMs: NOON - DAY - HOUR }),
      entry({ id: "y2", atMs: NOON - DAY }),
      entry({ id: "t1", atMs: NOON - 2 * HOUR }),
      entry({ id: "t2", atMs: NOON - HOUR }),
    ];
    const groups = groupByDay(log, NOON);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
    expect(groups[0]?.entries.map((e) => e.id)).toEqual(["t2", "t1"]);
    expect(groups[1]?.entries.map((e) => e.id)).toEqual(["y2", "y1"]);
  });

  it("sorts by atMs before grouping — an out-of-order file must not split one day into two groups", () => {
    const log = [
      entry({ id: "t2", atMs: NOON - HOUR }),
      entry({ id: "y1", atMs: NOON - DAY }),
      entry({ id: "t1", atMs: NOON - 2 * HOUR }),
    ];
    const groups = groupByDay(log, NOON);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.entries.map((e) => e.id)).toEqual(["t2", "t1"]);
  });

  it("two entries in the same millisecond: the later-written one is still on top", () => {
    const log = [entry({ id: "first" }), entry({ id: "second" })];
    expect(groupByDay(log, NOON)[0]?.entries.map((e) => e.id)).toEqual(["second", "first"]);
  });

  it("a day older than yesterday gets a date, never a relative word", () => {
    const groups = groupByDay([entry({ id: "o", atMs: NOON - 3 * DAY })], NOON);
    expect(groups[0]?.label).not.toMatch(/today|yesterday/i);
    expect(groups[0]?.label).toMatch(/22/);
  });

  it("a day in another year carries its year; a day in this year does not", () => {
    const lastYear = new Date(2025, 0, 3, 12).getTime();
    const thisYear = new Date(2026, 0, 3, 12).getTime();
    const labels = groupByDay([entry({ id: "a", atMs: lastYear }), entry({ id: "b", atMs: thisYear })], NOON).map((g) => g.label);
    expect(labels[0]).not.toMatch(/2026/);
    expect(labels[1]).toMatch(/2025/);
  });

  it("\"Yesterday\" is the previous calendar day even when the clocks changed overnight", () => {
    // Iterate every day of the year: on a DST day, `now - 24h` lands on the wrong date.
    for (let day = 1; day <= 366; day++) {
      const now = new Date(2026, 0, day, 0, 30).getTime();
      const prev = new Date(2026, 0, day - 1, 23, 30).getTime();
      expect(groupByDay([entry({ id: "p", atMs: prev })], now)[0]?.label).toBe("Yesterday");
    }
  });

  it("day boundaries follow the calendar, not 24-hour windows from now", () => {
    // 23:00 the day before is only two hours before 01:00, and still "Yesterday".
    const now = new Date(2026, 7, 25, 1, 0, 0).getTime();
    const lateYesterday = new Date(2026, 7, 24, 23, 0, 0).getTime();
    expect(groupByDay([entry({ id: "y", atMs: lateYesterday })], now)[0]?.label).toBe("Yesterday");
  });
});

describe("entryTime", () => {
  it("renders HH:MM in 24-hour form with a leading zero", () => {
    expect(entryTime(new Date(2026, 7, 25, 9, 5, 0).getTime())).toBe("09:05");
  });
});

describe("sourceName", () => {
  it("a session source shows the captured name, a string source shows itself", () => {
    expect(sourceName({ sessionId: null, name: "phase2-log-schema" })).toBe("phase2-log-schema");
    expect(sourceName("corral")).toBe("corral");
    expect(sourceName("operator")).toBe("operator");
  });
});
