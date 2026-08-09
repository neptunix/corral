import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../web/src/lib/api.ts";

afterEach(() => { vi.unstubAllGlobals(); });

// Captures the URL and method as well as the body. Asserting only the body lets the client POST to
// the wrong endpoint — or GET it — with every test still green, because the stub answers any request
// with a valid SpawnResult.
function captureFetch(): { bodies: unknown[]; urls: string[]; methods: (string | undefined)[] } {
  const bodies: unknown[] = [];
  const urls: string[] = [];
  const methods: (string | undefined)[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    urls.push(url);
    methods.push(init?.method);
    bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
    return Promise.resolve(new Response(JSON.stringify({ env: "e", paneId: "p", name: "n", workspaceLabel: "repo", cwdSnapshot: "/repo", idempotent: false }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
  });
  return { bodies, urls, methods };
}

describe("api.tasks.spawn", () => {
  it("POSTs the chosen model to the task's spawn route", async () => {
    const { bodies, urls, methods } = captureFetch();
    await api.tasks.spawn("b", "t", "work-local", null, "corral", "fable", false);
    expect(urls[0]).toBe("/api/boards/b/tasks/t/spawn");
    expect(methods[0]).toBe("POST");
    expect(bodies[0]).toEqual({ env: "work-local", targetWorkspaceId: null, repo: "corral", model: "fable" });
  });

  // "default" in the picker means "inherit whatever model this environment last used", which is what
  // sending NO model field does. A `model: null` would fail the route's Zod schema.
  // Unchecked sends NO field, not `remoteControl: false`. Absence is what the route reads as "off"
  // (Task 3), and it keeps the default body minimal — connecting a session to claude.ai is never
  // implied (spec A.1). The previous assertion above already pins that the default body has no
  // remoteControl key at all.
  it("omits the model field entirely for the default choice", async () => {
    const { bodies } = captureFetch();
    await api.tasks.spawn("b", "t", "work-local", null, "corral", null, false);
    expect(bodies[0]).toEqual({ env: "work-local", targetWorkspaceId: null, repo: "corral" });
  });

  it("sends remoteControl only when the box is ticked", async () => {
    const { bodies } = captureFetch();
    await api.tasks.spawn("b", "t", "work-local", null, "corral", null, true);
    expect(bodies[0]).toEqual({ env: "work-local", targetWorkspaceId: null, repo: "corral", remoteControl: true });
  });

  it("sends both together", async () => {
    const { bodies } = captureFetch();
    await api.tasks.spawn("b", "t", "work-local", "w1", null, "opus", true);
    expect(bodies[0]).toEqual({ env: "work-local", targetWorkspaceId: "w1", repo: null, model: "opus", remoteControl: true });
  });
});
