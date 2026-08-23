import type { LogEntry, LogKind } from "@shared/board-schema.ts";
import { LOG_ENTRY_TEXT_MAX, LogEntrySchema } from "@shared/board-schema.ts";
import { describe, expect, it } from "vitest";


import { appendLogEntry, LOG_NOTE_QUOTA, LOG_SYSTEM_QUOTA } from "../server/task-log.ts";

function entry(kind: LogKind, text: string, at: number): LogEntry {
  return { id: `e${String(at)}`, atMs: at, source: { sessionId: null, name: "s" }, kind, text };
}

function appendAll(seed: readonly LogEntry[], entries: readonly LogEntry[]): LogEntry[] {
  return entries.reduce<LogEntry[]>((log, e) => appendLogEntry(log, e), [...seed]);
}

const notes = (log: readonly LogEntry[]): LogEntry[] => log.filter((e) => e.kind === "note");
const system = (log: readonly LogEntry[]): LogEntry[] => log.filter((e) => e.kind !== "note");

describe("task log quotas", () => {
  // The §13 test: a single shared cap passes a naive "the cap works" check and still loses every
  // note. PR #67 closes every live session on a card in one operator action, so a burst of
  // `session_closed` lines is a real shape, not a hypothetical.
  it("a burst of 200 system entries leaves the 60 newest notes intact", () => {
    const seeded = appendAll([], Array.from({ length: LOG_NOTE_QUOTA }, (_, i) => entry("note", `note ${String(i)}`, i)));
    expect(notes(seeded)).toHaveLength(LOG_NOTE_QUOTA);

    const after = appendAll(seeded, Array.from({ length: 200 }, (_, i) => entry("session_closed", `closed ${String(i)}`, 1000 + i)));

    expect(notes(after).map((e) => e.text)).toEqual(
      Array.from({ length: LOG_NOTE_QUOTA }, (_, i) => `note ${String(i)}`),
    );
    expect(system(after)).toHaveLength(LOG_SYSTEM_QUOTA);
  });

  it("evicts the oldest note once the note quota is full, and no system entry", () => {
    const seeded = appendAll([], [
      ...Array.from({ length: LOG_NOTE_QUOTA }, (_, i) => entry("note", `note ${String(i)}`, i)),
      entry("created", "created", 500),
    ]);
    const after = appendLogEntry(seeded, entry("note", "newest", 900));

    expect(notes(after)).toHaveLength(LOG_NOTE_QUOTA);
    expect(notes(after)[0]?.text).toBe("note 1");
    expect(notes(after).at(-1)?.text).toBe("newest");
    expect(system(after).map((e) => e.text)).toEqual(["created"]);
  });

  it("keeps entries in append order across both families", () => {
    const log = appendAll([], [entry("note", "a", 1), entry("created", "b", 2), entry("note", "c", 3)]);
    expect(log.map((e) => e.text)).toEqual(["a", "b", "c"]);
  });
});

describe("task log entry truncation", () => {
  it("truncates text over the cap with a marker and never exceeds the cap", () => {
    const long = "x".repeat(LOG_ENTRY_TEXT_MAX + 50);
    const [stored] = appendLogEntry([], entry("note", long, 1));

    expect(stored?.text).toHaveLength(LOG_ENTRY_TEXT_MAX);
    expect(stored?.text.endsWith("…")).toBe(true);
  });

  it("leaves text at exactly the cap untouched", () => {
    const exact = "y".repeat(LOG_ENTRY_TEXT_MAX);
    const [stored] = appendLogEntry([], entry("note", exact, 1));

    expect(stored?.text).toBe(exact);
  });
});

describe("task log entry ids", () => {
  it("heals an entry stored without an id rather than refusing to load the board", () => {
    const parsed = LogEntrySchema.parse({ atMs: 1, source: "operator", kind: "note", text: "x" });
    expect(parsed.id).not.toBe("");
  });

  it("gives two entries written in the same millisecond distinct ids", () => {
    // `at` is not a key: closing every session on a card is N requests, each stamping its own clock
    // read, and two can land in the same millisecond.
    const a = LogEntrySchema.parse({ atMs: 5, source: "corral", kind: "session_closed", text: "a" });
    const b = LogEntrySchema.parse({ atMs: 5, source: "corral", kind: "session_closed", text: "b" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("task log time base", () => {
  // The UNIT is chosen by the route (server/api.ts) and pinned there — appendLogEntry never stamps a
  // timestamp, so no assertion here can tell millis from seconds. What this function does owe the
  // caller is that it does not touch the value it was handed: the log is read in order, and a helper
  // that rounded or re-stamped `atMs` would reorder entries with nothing else to catch it.
  it("stores the timestamp it was given, unmodified", () => {
    const nowMs = Date.now();
    const [stored] = appendLogEntry([], entry("note", "x", nowMs));

    expect(stored?.atMs).toBe(nowMs);
  });
});

describe("task log entry truncation — multi-byte text", () => {
  it("never stores half of a surrogate pair when the cut lands inside one", () => {
    // "😀" is two UTF-16 code units, so a cap at an odd offset can split it.
    const text = "a".repeat(LOG_ENTRY_TEXT_MAX - 2) + "😀😀";
    const [stored] = appendLogEntry([], entry("note", text, 1));

    expect(stored?.text.length).toBeLessThanOrEqual(LOG_ENTRY_TEXT_MAX);
    // A high surrogate with no low surrogate after it — half a character.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(stored?.text ?? "")).toBe(false);
  });
});
