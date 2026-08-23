import type { LogEntry, LogKind } from "@shared/board-schema.ts";
import { LOG_ENTRY_TEXT_MAX } from "@shared/board-schema.ts";
import { describe, expect, it } from "vitest";


import { appendLogEntry, LOG_NOTE_QUOTA, LOG_SYSTEM_QUOTA } from "../server/task-log.ts";

function entry(kind: LogKind, text: string, at: number): LogEntry {
  return { at, source: { sessionId: null, name: "s" }, kind, text };
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
