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

  it("treats an empty HERDR_ENV as absent", () => {
    expect(readHerdrEnv({ HERDR_ENV: "", HERDR_PANE_ID: "w1:p1" }, "/repo")).toBeNull();
  });

  it("treats an empty HERDR_SOCKET_PATH as absent, not a literal empty string", () => {
    expect(readHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "" }, "/repo")).toEqual({
      paneId: "w1:p1", socket: null, cwd: "/repo",
    });
  });

  it("forwards a whitespace-only pane id as-is, letting the server decide", () => {
    expect(readHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "   " }, "/repo")).toEqual({
      paneId: "   ", socket: null, cwd: "/repo",
    });
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

  it("does not cache a failed load, so a later load retries the client", async () => {
    let calls = 0;
    const stub: CorralClient = {
      ...client(resolvedBody),
      whoami: async () => {
        calls += 1;
        if (calls === 1) return { resolved: false, reason: "not yet resolvable", envs: [] };
        return resolvedBody;
      },
    };
    const id = createIdentity(stub, ctx);
    await expect(id.load()).rejects.toThrow(/not yet resolvable/);
    await expect(id.load()).resolves.toEqual(resolvedBody);
    expect(calls).toBe(2);
  });

  it("returns the whole card when bound, not just its coordinates", async () => {
    // The full card, so corral_task_update reads `columns` and corral_task_read reads `description`
    // off this same forced read rather than issuing a second one.
    const id = createIdentity(client(resolvedBody), ctx);
    await expect(id.requireCard()).resolves.toEqual(resolvedBody.task);
  });

  it("tells the caller to bind when unbound", async () => {
    const id = createIdentity(client({ ...resolvedBody, task: null }), ctx);
    await expect(id.requireCard()).rejects.toThrow(/corral_task_bind/);
  });
});
