import type { BoardFrame, TaskFrame } from "@shared/board-schema.ts";
import { describe, expect, it } from "vitest";

import { CARD_PAGE_LIMIT, pageCards } from "../mcp/card-query.ts";
import { filterLabel } from "../mcp/digest.ts";

function card(over: Partial<TaskFrame> & { id: string }): TaskFrame {
  return { title: over.id, description: "", status: "todo", priority: null, sessions: [], createdAt: 1, updatedAt: 1, ...over };
}

const board: BoardFrame = {
  id: "board", label: "Board",
  columns: [{ id: "todo", label: "Todo" }, { id: "doing", label: "Doing" }, { id: "done", label: "Done", type: "closed" }],
  tasks: [
    card({ id: "t_old", priority: null, createdAt: 1 }),
    card({ id: "t_p1", priority: "p1", createdAt: 2, title: "Fix the API" }),
    card({ id: "t_new", priority: null, createdAt: 3, status: "doing" }),
    card({ id: "t_done", priority: "p0", createdAt: 4, status: "done" }),
  ],
  spawnPresets: [], defaultSpawnPresetId: null,
};

describe("pageCards", () => {
  it("puts open cards first, then closed, each by priority then newest — storage order is never the answer", () => {
    expect(pageCards(board, {}, 0).tasks.map((t) => t.id)).toEqual(["t_p1", "t_new", "t_old", "t_done"]);
  });

  it("a fresh unprioritized open card outranks every closed card, whatever their priority", () => {
    const busy: BoardFrame = { ...board, tasks: [
      ...Array.from({ length: 60 }, (_, i) => card({ id: `t_done${String(i)}`, status: "done", priority: "p0", createdAt: 100 + i })),
      card({ id: "t_fresh", priority: null, createdAt: 1 }),
    ] };
    expect(pageCards(busy, {}, 0).tasks[0]?.id).toBe("t_fresh");
  });

  it("open drops cards in closed columns", () => {
    const page = pageCards(board, { open: true }, 0);
    expect(page.tasks.map((t) => t.id)).toEqual(["t_p1", "t_new", "t_old"]);
    expect(page.matched).toBe(3);
  });

  it("status keeps one column, priority one level, q a case-insensitive title substring", () => {
    expect(pageCards(board, { status: "doing" }, 0).tasks.map((t) => t.id)).toEqual(["t_new"]);
    expect(pageCards(board, { priority: "p1" }, 0).tasks.map((t) => t.id)).toEqual(["t_p1"]);
    expect(pageCards(board, { q: "the api" }, 0).tasks.map((t) => t.id)).toEqual(["t_p1"]);
  });

  it("pages at the row limit and reports the total matched, not the total stored", () => {
    const many: BoardFrame = { ...board, tasks: Array.from({ length: 120 }, (_, i) => card({ id: `t_${String(i).padStart(3, "0")}`, createdAt: i })) };
    const first = pageCards(many, {}, 0);
    expect(first.tasks).toHaveLength(CARD_PAGE_LIMIT);
    expect(first.tasks[0]?.id).toBe("t_119");
    expect(first.matched).toBe(120);
    const last = pageCards(many, {}, 100);
    expect(last.tasks).toHaveLength(20);
    expect(last.offset).toBe(100);
  });
});

describe("filterLabel", () => {
  it("names every active filter and nothing else", () => {
    expect(filterLabel({})).toBe("");
    expect(filterLabel({ open: true, status: "doing", priority: "p1", q: "api" })).toBe('open status=doing priority=p1 q="api"');
  });

  it("keeps a newline-injected q on one line", () => {
    expect(filterLabel({ q: "a\nb" })).not.toContain("\n");
  });
});
