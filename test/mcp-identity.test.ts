import type { WhoamiResponse } from "@shared/whoami-schema.ts";
import { describe, expect, it } from "vitest";

import type { CorralClient } from "../mcp/client.ts";
import { createIdentity, readHerdrEnv } from "../mcp/identity.ts";

const resolvedBody: WhoamiResponse = {
  resolved: true,
  session: {
    env: "work-local", envLabel: "Work (local)", paneId: "w1:p1", tabId: "tab1",
    tabLabel: "alpha", workspaceId: "ws1", workspaceLabel: "repo",
    sessionId: "11111111-2222-3333-4444-555555555555", sessionName: "alpha",
    cwd: "/repo", status: "working", model: "Opus",
    ctxPct: 41, costUsd: null, fiveHourPct: null, sevenDayPct: null, account: null,
  },
  task: {
    boardId: "board", boardLabel: "Board", taskId: "t_abcdefg", title: "T",
    description: "", status: "doing", priority: null, columns: [{ id: "doing", label: "Doing" }],
    sessions: [],
  },
  envs: [],
};

function client(body: WhoamiResponse, counter?: { n: number }): CorralClient {
  const stub = {
    whoami: async () => { if (counter !== undefined) counter.n += 1; return body; },
    attention: async () => ({}),
    state: async () => ({ envs: {}, sessions: [] }),
    boards: async () => [],
    patchTask: async () => { throw new Error("unused"); },
    attach: async () => undefined,
    spawn: async () => ({ env: "work-local", paneId: "w1:p2", name: "n" }),
    closeSession: async () => undefined,
  };
  return stub;
}

describe("readHerdrEnv", () => {
  it("returns null outside herdr", () => {
    expect(readHerdrEnv({}, "/repo")).toBeNull();
    expect(readHerdrEnv({ HERDR_PANE_ID: "w1:p1" }, "/repo")).toBeNull();
  });

  it("returns null inside herdr with no pane id", () => {
    expect(readHerdrEnv({ HERDR_ENV: "1" }, "/repo")).toBeNull();
  });

  it("reads pane id, socket, and cwd inside herdr", () => {
    const ctx = readHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/a.sock" }, "/repo");
    expect(ctx).toEqual({ paneId: "w1:p1", socket: "/tmp/a.sock", cwd: "/repo" });
  });

  it("treats a missing socket as null rather than failing", () => {
    expect(readHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, "/repo")?.socket).toBeNull();
  });
});

describe("createIdentity", () => {
  const ctx = { paneId: "w1:p1", socket: null, cwd: "/repo" };

  it("caches the resolved identity across calls", async () => {
    const counter = { n: 0 };
    const id = createIdentity(client(resolvedBody, counter), ctx);
    await id.load();
    await id.load();
    expect(counter.n).toBe(1);
  });

  it("re-fetches when forced", async () => {
    const counter = { n: 0 };
    const id = createIdentity(client(resolvedBody, counter), ctx);
    await id.load();
    await id.load(true);
    expect(counter.n).toBe(2);
  });

  it("throws the server's reason when unresolved", async () => {
    const id = createIdentity(client({ resolved: false, reason: "pane w1:p1 is ambiguous across environments: a, b", envs: [] }), ctx);
    await expect(id.load()).rejects.toThrow(/ambiguous/);
  });

  it("returns the card coordinates when bound", async () => {
    const id = createIdentity(client(resolvedBody), ctx);
    await expect(id.requireCard()).resolves.toEqual({ boardId: "board", taskId: "t_abcdefg" });
  });

  it("tells the caller to bind when unbound", async () => {
    const id = createIdentity(client({ ...resolvedBody, task: null }), ctx);
    await expect(id.requireCard()).rejects.toThrow(/corral_task_bind/);
  });
});
