import type { Board, SessionLink, Task } from "@shared/board-schema";
import type { AttentionMap, AttentionRecord, AttentionState } from "@shared/schema";
import { describe, expect, it } from "vitest";

import {
  attentionCountsByBoard, boardAttention, buildMembershipIndex, unassignedAttentionCount,
} from "../web/src/lib/attention.ts";

// Pins the client-side per-board attention attribution (SessionModal design 2026-07-10): the panel and
// every badge derive from (attention, boards) via buildMembershipIndex, so they cannot disagree. An
// attention record whose session is bound to no task maps to no board (→ the Unassigned surface).

function link(env: string, paneId: string): SessionLink {
  return { env, paneId, tabId: "", tabLabel: "", workspaceId: "", workspaceLabel: "", name: "", cwdSnapshot: "", sessionId: null };
}
function task(id: string, sessions: readonly SessionLink[]): Task {
  return { id, title: id, description: "", status: "todo", priority: null, repo: null, sessions: [...sessions], createdAt: 0, updatedAt: 0 };
}
function board(id: string, tasks: readonly Task[]): Board {
  return { id, label: id, columns: [], tasks: [...tasks] };
}
function rec(state: AttentionState, since: number): AttentionRecord {
  return { state, since, sessionName: null, lastLines: "", captured: false };
}

// Board A owns e:p1 (via task t1) and e:p2 (via task t2); Board B owns e:p3. e:p9 is bound to nothing.
const boards: readonly Board[] = [
  board("A", [task("t1", [link("e", "p1")]), task("t2", [link("e", "p2")])]),
  board("B", [task("t3", [link("e", "p3")])]),
];

describe("buildMembershipIndex", () => {
  it("maps env:paneId → owning board id and task title across boards and tasks", () => {
    const index = buildMembershipIndex(boards);
    expect(index.get("e:p1")).toEqual({ boardId: "A", taskTitle: "t1" });
    expect(index.get("e:p2")).toEqual({ boardId: "A", taskTitle: "t2" });
    expect(index.get("e:p3")).toEqual({ boardId: "B", taskTitle: "t3" });
  });

  it("omits sessions bound to no task", () => {
    expect(buildMembershipIndex(boards).has("e:p9")).toBe(false);
  });
});

describe("attentionCountsByBoard", () => {
  it("tallies bound attention records per board and excludes unassigned ones", () => {
    const attention: AttentionMap = {
      "e:p1": rec("blocked", 3), "e:p2": rec("finished", 2), // both board A
      "e:p3": rec("blocked", 1),                              // board B
      "e:p9": rec("blocked", 4),                              // unassigned — excluded
    };
    const counts = attentionCountsByBoard(attention, boards);
    expect(counts.get("A")).toBe(2);
    expect(counts.get("B")).toBe(1);
    expect(counts.has("e:p9")).toBe(false);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(3); // unassigned not counted anywhere
  });
});

describe("boardAttention", () => {
  it("returns only the given board's records, blocked before finished then most-recent first", () => {
    const attention: AttentionMap = {
      "e:p1": rec("finished", 5), // A, finished
      "e:p2": rec("blocked", 1),  // A, blocked (older) — must sort above the finished one
      "e:p3": rec("blocked", 9),  // B — excluded
      "e:p9": rec("blocked", 9),  // unassigned — excluded
    };
    const keys = boardAttention(attention, boards, "A").map((e) => e.key);
    expect(keys).toEqual(["e:p2", "e:p1"]);
  });

  it("orders two blocked records most-recent first", () => {
    const attention: AttentionMap = { "e:p1": rec("blocked", 1), "e:p2": rec("blocked", 8) };
    expect(boardAttention(attention, boards, "A").map((e) => e.key)).toEqual(["e:p2", "e:p1"]);
  });

  it("returns enriched entries carrying the key, record, and task title", () => {
    const attention: AttentionMap = { "e:p1": rec("blocked", 1) };
    const entries = boardAttention(attention, boards, "A");
    expect(entries[0]).toEqual({ key: "e:p1", record: rec("blocked", 1), taskTitle: "t1" });
  });
});

describe("unassignedAttentionCount", () => {
  it("counts only records whose session is bound to no board", () => {
    const attention: AttentionMap = {
      "e:p1": rec("blocked", 1), // bound (A)
      "e:p9": rec("blocked", 2), // unassigned
      "e:p8": rec("finished", 3), // unassigned
    };
    expect(unassignedAttentionCount(attention, boards)).toBe(2);
  });

  it("is zero when every attention record is bound", () => {
    expect(unassignedAttentionCount({ "e:p1": rec("blocked", 1) }, boards)).toBe(0);
  });
});
