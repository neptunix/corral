import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createStorage } from "../server/storage.ts";
import type { Board } from "../shared/board-schema.ts";

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "storage-test-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

const makeBoard = (id: string): Board => ({
  id, label: id, columns: [{ id: "todo", label: "Todo" }], tasks: [],
});

describe("createStorage", () => {
  it("listBoardIds returns empty on fresh dir", () => {
    expect(createStorage(tmpDir).listBoardIds()).toEqual([]);
  });

  it("withBoard creates and reads a board", async () => {
    const s = createStorage(tmpDir);
    await s.withBoard("test", () => ({ board: makeBoard("test"), result: undefined }));
    const b = s.getBoard("test");
    expect(b?.id).toBe("test");
    expect(b?.label).toBe("test");
  });

  it("withBoard returning null deletes the board", async () => {
    const s = createStorage(tmpDir);
    await s.withBoard("test", () => ({ board: makeBoard("test"), result: undefined }));
    await s.withBoard("test", () => ({ board: null, result: undefined }));
    expect(s.getBoard("test")).toBeNull();
  });

  it("concurrent writes do not lose updates (mutex)", async () => {
    const s = createStorage(tmpDir);
    await s.withBoard("test", () => ({ board: makeBoard("test"), result: undefined }));
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        s.withBoard("test", (b) => ({
          board: { ...b!, tasks: [...(b?.tasks ?? []), {
            id: `t_${String(i)}`, title: `T${String(i)}`, description: "",
            status: "todo", priority: null, repo: null, sessions: [],
            createdAt: i, updatedAt: i,
          }] },
          result: undefined,
        }))
      )
    );
    expect(s.getBoard("test")!.tasks).toHaveLength(10);
  });

  it("ensureFirstRunBoard creates personal.json when no boards exist", async () => {
    const s = createStorage(tmpDir);
    await s.ensureFirstRunBoard();
    expect(s.listBoardIds()).toContain("personal");
    const b = s.getBoard("personal");
    expect(b?.columns).toHaveLength(4);
  });

  it("ensureFirstRunBoard is idempotent (second call is noop)", async () => {
    const s = createStorage(tmpDir);
    await s.ensureFirstRunBoard();
    await s.ensureFirstRunBoard();
    expect(s.listBoardIds()).toHaveLength(1);
  });

  it("generateBoardId slugifies label", () => {
    const s = createStorage(tmpDir);
    expect(s.generateBoardId("My Board")).toBe("my-board");
  });

  it("generateBoardId appends suffix on collision", () => {
    const s = createStorage(tmpDir);
    // Simulate existing board with id "my-board"
    s.generateBoardId("My Board"); // warm up
    // Pass existing IDs explicitly
    expect(s.generateBoardIdAgainst("My Board", ["my-board"])).toBe("my-board-2");
  });
});

describe("withBoards (atomic two-board op)", () => {
  const seededTask = { id: "t_aaaaaaa", title: "x", description: "", status: "todo", priority: null, repo: null, sessions: [], createdAt: 1, updatedAt: 1 };

  it("updates both boards atomically and returns the result", async () => {
    const s = createStorage(tmpDir);
    await s.withBoard("a", () => ({ board: makeBoard("a"), result: undefined }));
    await s.withBoard("b", () => ({ board: makeBoard("b"), result: undefined }));
    const out = await s.withBoards("a", "b", (a, b) => ({
      boardA: a === null ? null : { ...a, label: "A2" },
      boardB: b === null ? null : { ...b, label: "B2" },
      result: "done",
    }));
    expect(out).toBe("done");
    expect(s.getBoard("a")?.label).toBe("A2");
    expect(s.getBoard("b")?.label).toBe("B2");
  });

  it("deletes a board when its returned value is null", async () => {
    const s = createStorage(tmpDir);
    await s.withBoard("a", () => ({ board: makeBoard("a"), result: undefined }));
    await s.withBoard("b", () => ({ board: makeBoard("b"), result: undefined }));
    await s.withBoards("a", "b", (_a, b) => ({ boardA: null, boardB: b, result: undefined }));
    expect(s.getBoard("a")).toBeNull();
    expect(s.getBoard("b")).not.toBeNull();
  });

  it("serializes concurrent opposite-arg-order ops without deadlocking (canonical lock order)", async () => {
    const s = createStorage(tmpDir);
    await s.withBoard("a", () => ({ board: { ...makeBoard("a"), tasks: [seededTask] }, result: undefined }));
    await s.withBoard("b", () => ({ board: makeBoard("b"), result: undefined }));
    // One op passes (b,a), the other (a,b) — opposite arg orders. Canonical path-sorted locking means
    // both acquire a-then-b, so they serialize instead of deadlocking (a real deadlock hangs the test).
    const move = s.withBoards("b", "a", (target, source) => {
      const task = source?.tasks.find((t) => t.id === "t_aaaaaaa");
      if (target === null || source === null || task === undefined) return { boardA: target, boardB: source, result: "skip" };
      return { boardA: { ...target, tasks: [...target.tasks, task] }, boardB: { ...source, tasks: [] }, result: "moved" };
    });
    const other = s.withBoards("a", "b", (a, b) => ({ boardA: a, boardB: b, result: "noop" }));
    const results = await Promise.all([move, other]);
    expect(results).toContain("moved");
    // The task ends up on exactly one board, never lost or duplicated.
    expect((s.getBoard("a")?.tasks.length ?? 0) + (s.getBoard("b")?.tasks.length ?? 0)).toBe(1);
  });
});
