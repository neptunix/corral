import { describe, expect, it } from "vitest";

import { CorralError, createClient } from "../mcp/client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// The mock fetchFn must stay assignable to `FetchFn` (`typeof fetch`), whose first parameter is
// `RequestInfo | URL` (i.e. `string | URL | Request`) — narrowing the mock's own parameter type to
// `string` would break that assignability under `strictFunctionTypes`. So narrow here, at each call
// site, instead: the client itself only ever calls `fetchFn` with a plain string, so this is an
// identity no-op at runtime, but it satisfies `no-base-to-string` without a suppression.
function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

const whoamiBody = {
  resolved: false,
  reason: "no live session at pane w9:p9 in any local environment",
  envs: [{ id: "work-local", label: "Work (local)", kind: "local", reachable: true }],
};

describe("corral client", () => {
  it("sends identity hints as query parameters", async () => {
    const urls: string[] = [];
    const client = createClient("http://127.0.0.1:8787", async (input) => {
      urls.push(urlOf(input));
      return jsonResponse(whoamiBody);
    });
    await client.whoami({ paneId: "w1:p1", cwd: "/repo", socket: "/tmp/a.sock" });
    const url = new URL(urls[0] ?? "");
    expect(url.pathname).toBe("/api/whoami");
    expect(url.searchParams.get("paneId")).toBe("w1:p1");
    expect(url.searchParams.get("cwd")).toBe("/repo");
    expect(url.searchParams.get("socket")).toBe("/tmp/a.sock");
  });

  it("omits the socket parameter when there is none", async () => {
    const urls: string[] = [];
    const client = createClient("http://127.0.0.1:8787", async (input) => {
      urls.push(urlOf(input));
      return jsonResponse(whoamiBody);
    });
    await client.whoami({ paneId: "w1:p1", cwd: "/repo", socket: null });
    expect(new URL(urls[0] ?? "").searchParams.has("socket")).toBe(false);
  });

  it("throws a CorralError carrying the server error code", async () => {
    const client = createClient("http://127.0.0.1:8787", async () =>
      jsonResponse({ error: { code: "conflict", message: "session already assigned" } }, 409));
    await expect(client.attach({ boardId: "b", taskId: "t_abcdefg", env: "work-local", paneId: "w1:p1", name: "n" }))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("throws a CorralError with an unreachable code when the server is down", async () => {
    const client = createClient("http://127.0.0.1:8787", async () => { throw new Error("ECONNREFUSED"); });
    await expect(client.attention()).rejects.toBeInstanceOf(CorralError);
    await expect(client.attention()).rejects.toMatchObject({ code: "unreachable" });
  });

  it("rejects a response that does not match the schema", async () => {
    const client = createClient("http://127.0.0.1:8787", async () => jsonResponse({ resolved: "yes" }));
    await expect(client.whoami({ paneId: "w1:p1", cwd: "/repo", socket: null }))
      .rejects.toMatchObject({ code: "bad_response" });
  });

  it("PATCHes only the fields it was given", async () => {
    let sentBody = "";
    const client = createClient("http://127.0.0.1:8787", async (_input, init) => {
      sentBody = typeof init?.body === "string" ? init.body : "";
      return jsonResponse({
        id: "t_abcdefg", title: "T", description: "", status: "doing", priority: null,
        repo: null, sessions: [], createdAt: 1, updatedAt: 2,
      });
    });
    await client.patchTask({ boardId: "b", taskId: "t_abcdefg", patch: { status: "doing" } });
    expect(JSON.parse(sentBody)).toEqual({ status: "doing" });
  });

  it("passes sid and deferred as close query parameters", async () => {
    const urls: string[] = [];
    const client = createClient("http://127.0.0.1:8787", async (input) => {
      urls.push(urlOf(input));
      return jsonResponse({ ok: true });
    });
    await client.closeSession({
      boardId: "b", taskId: "t_abcdefg", env: "work-local", paneId: "w1:p1",
      sessionId: "11111111-2222-3333-4444-555555555555", deferred: true,
    });
    const url = new URL(urls[0] ?? "");
    expect(url.searchParams.get("sid")).toBe("11111111-2222-3333-4444-555555555555");
    expect(url.searchParams.get("deferred")).toBe("1");
  });

  it("fetches and parses a realistic state snapshot", async () => {
    const urls: string[] = [];
    const snapshotBody = {
      envs: { "work-local": { reachable: true, kind: "local", label: "Work (local)" } },
      sessions: [{
        env: "work-local", paneId: "w1:p1", status: "working", agent: "claude", cwd: "/repo",
        tab: "t1", workspace: "ws1", tabId: "tab-1", workspaceId: "ws-1", sessionId: null,
        recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null,
      }],
    };
    const client = createClient("http://127.0.0.1:8787", async (input) => {
      urls.push(urlOf(input));
      return jsonResponse(snapshotBody);
    });
    const state = await client.state();
    expect(new URL(urls[0] ?? "").pathname).toBe("/api/state");
    expect(state).toEqual(snapshotBody);
  });

  it("fetches and parses a realistic board list", async () => {
    const urls: string[] = [];
    const boardsBody = [{
      id: "personal", label: "Personal",
      columns: [{ id: "todo", label: "Todo" }, { id: "doing", label: "Doing" }],
      tasks: [{
        id: "t_abcdefg", title: "Ship the client", description: "", status: "doing",
        priority: "p1", repo: null, sessions: [], createdAt: 1, updatedAt: 2,
      }],
    }];
    const client = createClient("http://127.0.0.1:8787", async (input) => {
      urls.push(urlOf(input));
      return jsonResponse(boardsBody);
    });
    const boards = await client.boards();
    expect(new URL(urls[0] ?? "").pathname).toBe("/api/boards");
    expect(boards).toEqual(boardsBody);
  });

  it("spawns a session with the exact method, URL, and JSON body the route expects", async () => {
    const calls: { url: string; method: string | undefined; body: string }[] = [];
    // A realistic spawn response: the real route (server/api.ts) replies with the full stored
    // SessionLink plus `idempotent`, not the bare {env,paneId,name} the client's schema declares —
    // SpawnResultSchema is intentionally non-strict, so it must accept this superset and strip the rest.
    const client = createClient("http://127.0.0.1:8787", async (input, init) => {
      calls.push({ url: urlOf(input), method: init?.method, body: typeof init?.body === "string" ? init.body : "" });
      return jsonResponse({
        env: "work-local", paneId: "w2:p3", tabId: "tab-2", tabLabel: "task-a",
        workspaceId: "ws-2", workspaceLabel: "task-a", name: "task-a", cwdSnapshot: "/repo",
        sessionId: null, idempotent: false,
      });
    });
    const result = await client.spawn({ boardId: "b", taskId: "t_abcdefg", env: "work-local", brief: "run the tests" });
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(new URL(call?.url ?? "").pathname).toBe("/api/boards/b/tasks/t_abcdefg/spawn");
    expect(JSON.parse(call?.body ?? "")).toEqual({ env: "work-local", brief: "run the tests" });
    expect(result).toEqual({ env: "work-local", paneId: "w2:p3", name: "task-a" });
  });

  it("throws bad_response when the body is not valid JSON", async () => {
    const client = createClient("http://127.0.0.1:8787", async () =>
      new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }));
    await expect(client.attention()).rejects.toMatchObject({ code: "bad_response" });
  });
});
