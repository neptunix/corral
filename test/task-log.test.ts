import type { LogEntry, LogKind, SessionLink } from "@shared/board-schema.ts";
import { LOG_ENTRY_TEXT_MAX, LogEntrySchema } from "@shared/board-schema.ts";
import type { SessionRow } from "@shared/schema";
import { describe, expect, it } from "vitest";

import { appendLogEntry, LOG_NOTE_QUOTA, LOG_SYSTEM_QUOTA, resolveWriter, sessionRef, stampSystem } from "../server/task-log.ts";

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

describe("task log entry truncation — system entries only", () => {
  it("truncates a system entry over the cap with a marker and never exceeds the cap", () => {
    const long = "x".repeat(LOG_ENTRY_TEXT_MAX + 50);
    const [stored] = appendLogEntry([], entry("session_closed", long, 1));

    expect(stored?.text).toHaveLength(LOG_ENTRY_TEXT_MAX);
    expect(stored?.text.endsWith("…")).toBe(true);
  });

  it("never cuts a note — the route refuses one over the cap, so what arrives here is stored whole", () => {
    const long = "x".repeat(LOG_ENTRY_TEXT_MAX + 50);
    const [stored] = appendLogEntry([], entry("note", long, 1));

    expect(stored?.text).toBe(long);
  });

  it("leaves text at exactly the cap untouched", () => {
    const exact = "y".repeat(LOG_ENTRY_TEXT_MAX);
    const [stored] = appendLogEntry([], entry("created", exact, 1));

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
    const [stored] = appendLogEntry([], entry("session_spawned", text, 1));

    expect(stored?.text.length).toBeLessThanOrEqual(LOG_ENTRY_TEXT_MAX);
    // A high surrogate with no low surrogate after it — half a character.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(stored?.text ?? "")).toBe(false);
  });
});

function baseTask(log: readonly LogEntry[] = []): Parameters<typeof stampSystem>[0] {
  return { id: "t_aaaaaaa", title: "T", description: "", status: "todo", priority: null, sessions: [], createdAt: 1, updatedAt: 2, log: [...log] };
}

describe("stampSystem", () => {
  it("appends a corral-sourced system entry", () => {
    const out = stampSystem(baseTask(), "created", "card created");
    expect(out.log).toHaveLength(1);
    expect(out.log[0]).toMatchObject({ kind: "created", source: "corral", text: "card created" });
  });

  it("evicts against the SYSTEM quota, leaving notes untouched", () => {
    // A card already at its note quota plus one system entry; a burst of system stamps must evict
    // only system entries — the failure separate quotas exist to prevent.
    const seed = appendAll([], [
      ...Array.from({ length: LOG_NOTE_QUOTA }, (_, i) => entry("note", `n${String(i)}`, i)),
    ]);
    let task = baseTask(seed);
    for (let i = 0; i < LOG_SYSTEM_QUOTA + 5; i++) task = stampSystem(task, "session_bound", `b${String(i)}`);
    expect(task.log.filter((e) => e.kind === "note")).toHaveLength(LOG_NOTE_QUOTA);
    expect(task.log.filter((e) => e.kind !== "note")).toHaveLength(LOG_SYSTEM_QUOTA);
  });
});

function liveRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    env: "work-local", paneId: "w1:p1", status: "working", agent: "claude", cwd: "/repo",
    tab: "t", workspace: "w", tabId: "tab1", workspaceId: "ws1", sessionId: null,
    recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null,
    statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null,
    registryStatus: null, claudeName: null, claudeNameUserSet: null, ...over,
  };
}

const storedLink = (name: string, paneId = "w1:p1", sessionId: string | null = null): SessionLink => ({
  env: "work-local", paneId, tabId: "tb", tabLabel: "x", workspaceId: "ws", workspaceLabel: "w",
  name, cwdSnapshot: "/x", sessionId,
});

describe("resolveWriter", () => {
  it("resolves a pane to the link that binds it, across groups", () => {
    const src = resolveWriter(
      [{ sessions: [] }, { sessions: [storedLink("worker-a")] }],
      { env: "work-local", paneId: "w1:p1" },
      [liveRow()],
    );
    expect(src).toEqual({ sessionId: null, name: "worker-a" });
  });

  it("returns null for a pane bound in no group", () => {
    expect(resolveWriter([{ sessions: [storedLink("x", "w1:p9")] }], { env: "work-local", paneId: "w1:p1" }, [])).toBeNull();
  });

  it("prefers the FIRST group's link — the target card's fresh copy over a stale fleet snapshot", () => {
    const src = resolveWriter(
      [{ sessions: [storedLink("fresh")] }, { sessions: [storedLink("stale")] }],
      { env: "work-local", paneId: "w1:p1" },
      [liveRow()],
    );
    expect(src).toEqual({ sessionId: null, name: "fresh" });
  });
});

describe("sessionRef", () => {
  it("names a session by its card label and fleet key", () => {
    expect(sessionRef({ name: "worker-a", env: "work-local", paneId: "w1:p1" })).toBe("worker-a (work-local:w1:p1)");
  });
});
