import { describe, expect, it } from "vitest";

import { CorralError, createClient } from "../mcp/client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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
      // fetchFn is only ever called with a string URL; fetch()'s wider signature also allows
      // Request/URL, so the union defeats no-base-to-string's static check.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      urls.push(String(input));
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
      // fetchFn is only ever called with a string URL; fetch()'s wider signature also allows
      // Request/URL, so the union defeats no-base-to-string's static check.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      urls.push(String(input));
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
      // fetchFn is only ever called with a string URL; fetch()'s wider signature also allows
      // Request/URL, so the union defeats no-base-to-string's static check.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      urls.push(String(input));
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
});
