import { describe, it, expect } from "vitest";

import {
  BoardSchema, BoardStateSchema, ColumnSchema, GlobalStateSchema, LiveSessionDataSchema, SessionLinkSchema,
  TaskSchema, closedColumnIds, sortTasks, slugifyBoardId, generateTaskId, generateSpawnPresetId, DEFAULT_COLUMNS,
} from "../shared/board-schema.ts";

const LINK_BASE = { env: "e", paneId: "p1", tabId: "", tabLabel: "", workspaceId: "", workspaceLabel: "", name: "n", cwdSnapshot: "" };

describe("SessionLinkSchema", () => {
  it("defaults sessionId to null when absent (legacy on-disk links heal on parse)", () => {
    expect(SessionLinkSchema.parse(LINK_BASE).sessionId).toBeNull();
  });
  it("keeps a provided sessionId (the stable Claude UUID)", () => {
    expect(SessionLinkSchema.parse({ ...LINK_BASE, sessionId: "uuid-1" }).sessionId).toBe("uuid-1");
  });
});

describe("BoardSchema", () => {
  it("parses a valid board", () => {
    const b = BoardSchema.parse({ id: "personal", label: "Personal", columns: [{ id: "todo", label: "Todo" }] });
    expect(b.tasks).toEqual([]);
  });

  it("rejects missing id", () => {
    expect(() => BoardSchema.parse({ label: "x", columns: [] })).toThrow();
  });
});

describe("TaskSchema", () => {
  it("defaults description, priority, sessions", () => {
    const t = TaskSchema.parse({ id: "t_abc1234", title: "Test", status: "todo", createdAt: 1, updatedAt: 1 });
    expect(t.description).toBe("");
    expect(t.priority).toBeNull();
    expect(t.sessions).toEqual([]);
  });

  // A card no longer carries a repository — the spawn target comes from the request. Boards written
  // before that still hold the key: they must keep parsing, and lose it on the next write.
  it("parses a stored task carrying a legacy repo and drops the field", () => {
    const t = TaskSchema.parse({ id: "t_abc1234", title: "Test", status: "todo", repo: "corral", createdAt: 1, updatedAt: 1 });
    expect(Object.hasOwn(t, "repo")).toBe(false);
  });

  it("rejects unknown priority", () => {
    expect(() => TaskSchema.parse({ id: "t_x", title: "x", status: "todo", priority: "p9", createdAt: 1, updatedAt: 1 })).toThrow();
  });
});

describe("sortTasks", () => {
  it("sorts p0 before p1 before null", () => {
    const tasks = [
      { id: "a", title: "a", status: "todo", priority: null, description: "", sessions: [], createdAt: 1, updatedAt: 1 },
      { id: "b", title: "b", status: "todo", priority: "p1" as const, description: "", sessions: [], createdAt: 2, updatedAt: 2 },
      { id: "c", title: "c", status: "todo", priority: "p0" as const, description: "", sessions: [], createdAt: 3, updatedAt: 3 },
    ];
    const sorted = sortTasks(tasks);
    expect(sorted.map(t => t.id)).toEqual(["c", "b", "a"]);
  });

  it("breaks priority ties by createdAt DESC (newest first)", () => {
    const tasks = [
      { id: "a", title: "a", status: "todo", priority: "p1" as const, description: "", sessions: [], createdAt: 10, updatedAt: 10 },
      { id: "b", title: "b", status: "todo", priority: "p1" as const, description: "", sessions: [], createdAt: 20, updatedAt: 20 },
    ];
    expect(sortTasks(tasks).map(t => t.id)).toEqual(["b", "a"]);
  });
});

describe("slugifyBoardId", () => {
  it("lowercases and replaces non-alphanumeric", () => {
    expect(slugifyBoardId("My Board!")).toBe("my-board");
  });
  it("truncates to 32 chars", () => {
    expect(slugifyBoardId("a".repeat(50))).toHaveLength(32);
  });
  it("falls back to 'board' for empty result", () => {
    expect(slugifyBoardId("!!!")).toBe("board");
  });
});

describe("generateTaskId", () => {
  it("starts with t_", () => {
    expect(generateTaskId()).toMatch(/^t_/);
  });
  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, generateTaskId));
    expect(ids.size).toBe(100);
  });
});

describe("BoardStateSchema", () => {
  it("attention defaults to {} when absent", () => {
    const base = { board: { id: "b", label: "B", columns: [], tasks: [] }, tasks: [], unassigned: [], envs: {} };
    const parsed = BoardStateSchema.parse(base);
    expect(parsed.attention).toEqual({});
  });
});

describe("ColumnSchema type", () => {
  it("defaults type to undefined when absent (legacy columns heal on parse)", () => {
    const c = ColumnSchema.parse({ id: "todo", label: "Todo" });
    expect(c.type).toBeUndefined();
  });
  it("keeps a valid type", () => {
    expect(ColumnSchema.parse({ id: "x", label: "X", type: "closed" }).type).toBe("closed");
  });
  it("rejects an unknown type", () => {
    expect(() => ColumnSchema.parse({ id: "x", label: "X", type: "archived" })).toThrow();
  });
});

describe("closedColumnIds", () => {
  it("collects ids of closed-typed columns only", () => {
    const cols = [
      { id: "a", label: "A", type: "to-do" as const },
      { id: "b", label: "B", type: "closed" as const },
      { id: "c", label: "C" },
      { id: "d", label: "D", type: "closed" as const },
    ];
    expect(closedColumnIds(cols)).toEqual(new Set(["b", "d"]));
  });
  it("returns an empty set when no column is closed", () => {
    expect(closedColumnIds([{ id: "a", label: "A" }])).toEqual(new Set());
  });
});

describe("DEFAULT_COLUMNS types", () => {
  it("maps done to closed and todo to to-do", () => {
    const byId = new Map(DEFAULT_COLUMNS.map((c) => [c.id, c.type]));
    expect(byId.get("done")).toBe("closed");
    expect(byId.get("todo")).toBe("to-do");
  });
});

describe("statusline frame fields", () => {
  it("GlobalState defaults accounts to [] for older frames", () => {
    const parsed = GlobalStateSchema.parse({ unassigned: [], envs: {}, attention: {} });
    expect(parsed.accounts).toEqual([]);
  });

  it("LiveSessionData carries recap + statusline", () => {
    const parsed = LiveSessionDataSchema.parse({
      status: "working", model: "Opus", ctxPct: "42", detached: false,
      recap: "did X", recapAt: 5, statusline: null,
    });
    expect(parsed.recap).toBe("did X");
    expect(parsed.statusline).toBeNull();
  });

  it("LiveSessionData carries Claude's own state and its health", () => {
    const parsed = LiveSessionDataSchema.parse({
      status: "working", model: null, ctxPct: null, detached: false,
      claudeStatus: "waiting", waitingFor: "input needed", remoteControl: true, registryStatus: "ok",
    });
    expect(parsed.claudeStatus).toBe("waiting");
    expect(parsed.waitingFor).toBe("input needed");
    expect(parsed.remoteControl).toBe(true);
    expect(parsed.registryStatus).toBe("ok");
  });

  it("LiveSessionData defaults them to null for a payload that predates them", () => {
    const parsed = LiveSessionDataSchema.parse({ status: "working", model: null, ctxPct: null, detached: false });
    expect(parsed.claudeStatus).toBeNull();
    expect(parsed.waitingFor).toBeNull();
    expect(parsed.registryStatus).toBeNull();
    // null, NOT false — the tri-state survives the projection or the badge lies about disconnected
    // sessions on every payload written by an older server.
    expect(parsed.remoteControl).toBeNull();
  });

  it("rejects an unknown registryStatus on the wire too", () => {
    expect(LiveSessionDataSchema.safeParse({
      status: "working", model: null, ctxPct: null, detached: false, registryStatus: "made-up",
    }).success).toBe(false);
  });
});

describe("spawn presets on the board", () => {
  it("heals a board persisted before the fields existed", () => {
    const b = BoardSchema.parse({ id: "b", label: "B", columns: [{ id: "todo", label: "Todo" }] });
    expect(b.spawnPresets).toEqual([]);
    expect(b.defaultSpawnPresetId).toBeNull();
  });

  it("keeps a stored preset whose text is blank or over-long — content rules live at the PATCH boundary", () => {
    const b = BoardSchema.parse({
      id: "b", label: "B", columns: [{ id: "todo", label: "Todo" }],
      spawnPresets: [{ id: "p1", text: "" }, { id: "p2", text: "x".repeat(5000) }],
      defaultSpawnPresetId: "p2",
    });
    expect(b.spawnPresets).toHaveLength(2);
  });

  it("mints ids that are non-empty and distinct", () => {
    expect(generateSpawnPresetId()).not.toBe(generateSpawnPresetId());
    expect(generateSpawnPresetId().length).toBeGreaterThan(0);
  });
});
