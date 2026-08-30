import { describe, expect, it } from "vitest";

import { CorralError, createClient } from "../mcp/client.ts";
import { runTool } from "../mcp/tools/reply.ts";

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

  // Through runTool, not just the client: the advice in a bad_response shares one 300-char budget
  // with the Zod path, and the path is the only part that says WHICH field drifted. A longer message
  // still throws the right code, so a `code` assertion alone would not notice it crowding the path out.
  it("leaves room for the offending field name after truncation", async () => {
    const session = {
      env: "work-local", envLabel: "Work (local)", paneId: "w1:p1", tabId: "tab1", tabLabel: "t",
      workspaceId: "ws1", workspaceLabel: "repo", sessionId: null, sessionName: null, cwd: "/repo",
      status: "working", model: null, ctxPct: null, costUsd: null, fiveHourPct: null,
      sevenDayPct: null, account: null,
      // remoteControl omitted — exactly what a corral server predating the field sends.
    };
    const client = createClient("http://127.0.0.1:8787", async () => jsonResponse({ resolved: true, session, task: null, envs: [] }));
    const out = await runTool(async () => { await client.whoami({ paneId: "w1:p1", cwd: "/repo", socket: null }); return "unreachable"; });
    expect(out).toContain("Restart corral");
    expect(out).toContain("remoteControl");
  });

  it("PATCHes only the fields it was given", async () => {
    let sentBody = "";
    const client = createClient("http://127.0.0.1:8787", async (_input, init) => {
      sentBody = typeof init?.body === "string" ? init.body : "";
      return jsonResponse({
        id: "t_abcdefg", title: "T", description: "", status: "doing", priority: null,
        sessions: [], createdAt: 1, updatedAt: 2,
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
        recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
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
        priority: "p1", sessions: [], createdAt: 1, updatedAt: 2,
      }],
      spawnPresets: [], defaultSpawnPresetId: null,
    }];
    const client = createClient("http://127.0.0.1:8787", async (input) => {
      urls.push(urlOf(input));
      return jsonResponse(boardsBody);
    });
    const boards = await client.boards();
    expect(new URL(urls[0] ?? "").pathname).toBe("/api/boards");
    // The list route serves boards log-free, and the client parses them that way — a `log` in the body
    // is stripped rather than carried into this process.
    expect(boards).toEqual(boardsBody);
  });

  it("spawns a session with the exact method, URL, and JSON body the route expects", async () => {
    const calls: { url: string; method: string | undefined; body: string }[] = [];
    // A realistic spawn response: the real route (server/api.ts) replies with the full stored
    // SessionLink plus `idempotent`, a superset of what the client's schema declares —
    // SpawnResultSchema is intentionally non-strict, so it must accept it and strip the rest.
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
    expect(result).toEqual({
      env: "work-local", paneId: "w2:p3", name: "task-a",
      workspaceLabel: "task-a", cwdSnapshot: "/repo", idempotent: false,
    });
  });

  it("sends name, model and remoteControl in the spawn body when supplied", async () => {
    const bodies: unknown[] = [];
    const client = createClient("http://127.0.0.1:8787", async (_input, init) => {
      bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
      return jsonResponse({ env: "work-local", paneId: "w2:p3", name: "task-rc", workspaceLabel: "repo", cwdSnapshot: "/repo", idempotent: false });
    });
    await client.spawn({ boardId: "b", taskId: "t_abcdefg", env: "work-local", brief: "go", name: "rc toggle", model: "fable", remoteControl: true });
    expect(bodies[0]).toEqual({ env: "work-local", brief: "go", name: "rc toggle", model: "fable", remoteControl: true });
  });

  // The existing "exact JSON body" test above asserts `toEqual({ env, brief })`. Absent optionals must
  // stay ABSENT rather than serialising as `"name": null` — the route's Zod schema would still accept
  // it, but the body would stop being the minimal one that test pins.
  it("omits name, model and remoteControl from the spawn body when absent", async () => {
    const bodies: unknown[] = [];
    const client = createClient("http://127.0.0.1:8787", async (_input, init) => {
      bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
      return jsonResponse({ env: "work-local", paneId: "w2:p3", name: "task-a", workspaceLabel: "repo", cwdSnapshot: "/repo", idempotent: false });
    });
    await client.spawn({ boardId: "b", taskId: "t_abcdefg", env: "work-local", brief: "go" });
    expect(bodies[0]).toEqual({ env: "work-local", brief: "go" });
  });

  it("encodes a crafted taskId so it cannot splice extra path segments or reopen the query string", async () => {
    // A taskId containing "/" and "?" could otherwise make the interpolated path resolve to a
    // DIFFERENT route (e.g. .../close instead of .../attach) with the rest swallowed into the
    // query string — the exact defect this test guards against.
    const urls: string[] = [];
    const client = createClient("http://127.0.0.1:8787", async (input) => {
      urls.push(urlOf(input));
      return jsonResponse({ ok: true });
    });
    const evilTaskId = "t_abcdefg/sessions/work-local/w1:p9/close?x=";
    await client.attach({ boardId: "board", taskId: evilTaskId, env: "work-local", paneId: "w1:p1", name: "n" });
    const url = new URL(urls[0] ?? "");
    expect(url.pathname).toBe(`/api/boards/board/tasks/${encodeURIComponent(evilTaskId)}/attach`);
    expect(url.pathname.endsWith("/attach")).toBe(true);
    expect(url.searchParams.toString()).toBe("");
  });

  it("throws bad_response when the body is not valid JSON", async () => {
    const client = createClient("http://127.0.0.1:8787", async () =>
      new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }));
    await expect(client.attention()).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("corral client — spawn target and location", () => {
  it("sends repo in the spawn body when supplied, and omits it when not", async () => {
    const bodies: unknown[] = [];
    const client = createClient("http://127.0.0.1:8787", async (_input, init) => {
      bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
      return jsonResponse({ env: "work-local", paneId: "w2:p3", name: "task-a", workspaceLabel: "repo", cwdSnapshot: "/repo", idempotent: false });
    });
    await client.spawn({ boardId: "b", taskId: "t_abcdefg", env: "work-local", brief: "go", repo: "corral" });
    await client.spawn({ boardId: "b", taskId: "t_abcdefg", env: "work-local", brief: "go" });
    expect(bodies[0]).toEqual({ env: "work-local", brief: "go", repo: "corral" });
    expect(bodies[1]).toEqual({ env: "work-local", brief: "go" });
  });

  it("carries workspaceLabel, cwdSnapshot and idempotent through from the route", async () => {
    const client = createClient("http://127.0.0.1:8787", async () => jsonResponse({
      env: "work-local", paneId: "w2:p3", name: "task-a",
      workspaceLabel: "corral", cwdSnapshot: "/repos/corral", idempotent: true,
    }));
    const r = await client.spawn({ boardId: "b", taskId: "t_abcdefg", env: "work-local", brief: "go" });
    expect(r.workspaceLabel).toBe("corral");
    expect(r.cwdSnapshot).toBe("/repos/corral");
    expect(r.idempotent).toBe(true);
  });

  it("reads the configured repo names from the existing spawn-targets route", async () => {
    const urls: string[] = [];
    const client = createClient("http://127.0.0.1:8787", async (input) => {
      urls.push(urlOf(input));
      return jsonResponse({ spaces: [{ workspaceId: "w1", label: "corral" }], repos: [{ name: "corral" }, { name: "demo-api" }] });
    });
    const repos = await client.spawnTargets("work-local");
    expect(new URL(urls[0] ?? "").pathname).toBe("/api/envs/work-local/spawn-targets");
    expect(repos).toEqual(["corral", "demo-api"]);
  });

  it("encodes a crafted env id in the spawn-targets path", async () => {
    const urls: string[] = [];
    const client = createClient("http://127.0.0.1:8787", async (input) => {
      urls.push(urlOf(input));
      return jsonResponse({ spaces: [], repos: [] });
    });
    await client.spawnTargets("a/b?c");
    expect(new URL(urls[0] ?? "").pathname).toBe("/api/envs/a%2Fb%3Fc/spawn-targets");
  });
});

describe("corral client — spawn-targets is a hard boundary", () => {
  // `repos: null` means "the names could not be read" to the digest formatter. Defaulting a missing
  // or malformed `repos` to [] would turn that into a factual claim — "this environment has no
  // repositories configured" — asserted from absent data, straight into a Claude session's context.
  it("rejects a body with no repos array rather than defaulting it to empty", async () => {
    const client = createClient("http://127.0.0.1:8787", async () => jsonResponse({ spaces: [] }));
    await expect(client.spawnTargets("work-local")).rejects.toMatchObject({ code: "bad_response" });
  });
});
