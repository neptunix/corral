import type { Column } from "@shared/board-schema";
import { defaultColumnId } from "@shared/board-schema";
import { describe, expect, it } from "vitest";

describe("defaultColumnId", () => {
  it("returns the first column when nothing is closed", () => {
    const cols: Column[] = [{ id: "todo", label: "Todo" }, { id: "doing", label: "Doing" }];
    expect(defaultColumnId(cols)).toBe("todo");
  });

  it("skips a closed column sitting at position 0", () => {
    const cols: Column[] = [
      { id: "done", label: "Done", type: "closed" },
      { id: "todo", label: "Todo", type: "to-do" },
    ];
    expect(defaultColumnId(cols)).toBe("todo");
  });

  it("falls back to columns[0] when every column is closed", () => {
    const cols: Column[] = [
      { id: "done", label: "Done", type: "closed" },
      { id: "shipped", label: "Shipped", type: "closed" },
    ];
    expect(defaultColumnId(cols)).toBe("done");
  });

  it("returns undefined for an empty board", () => {
    expect(defaultColumnId([])).toBeUndefined();
  });

  it("treats an untyped legacy column as open", () => {
    expect(defaultColumnId([{ id: "backlog", label: "Backlog" }])).toBe("backlog");
  });
});
