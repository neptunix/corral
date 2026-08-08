import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../web/src/lib/api.ts";

afterEach(() => { vi.unstubAllGlobals(); });

function captureFetch(): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
    return Promise.resolve(new Response(JSON.stringify({ env: "e", paneId: "p", name: "n" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
  });
  return { bodies };
}

describe("api.tasks.spawn", () => {
  it("sends the chosen model", async () => {
    const { bodies } = captureFetch();
    await api.tasks.spawn("b", "t", "work-local", null, "corral", "fable", false);
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
