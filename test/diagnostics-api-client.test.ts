import { emptyDiagnostics } from "@shared/diagnostics-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../web/src/lib/api";

const calls: { url: string; method: string | undefined }[] = [];

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method });
    return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  });
}

beforeEach(() => { calls.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("api.diagnostics.refresh", () => {
  it("POSTs the refresh route", async () => {
    stubFetch(200, emptyDiagnostics());
    await api.diagnostics.refresh();
    expect(calls[0]?.url).toBe("/api/diagnostics/refresh");
    expect(calls[0]?.method).toBe("POST");
  });

  it("returns the parsed snapshot", async () => {
    stubFetch(200, { ...emptyDiagnostics(), lastError: "boom" });
    await expect(api.diagnostics.refresh()).resolves.toMatchObject({ lastError: "boom" });
  });

  // Proves the Zod boundary is real rather than decorative — `req` itself does not validate.
  it("rejects a body that is not a snapshot", async () => {
    stubFetch(200, { checks: [] });
    await expect(api.diagnostics.refresh()).rejects.toThrow();
  });

  // The exact shape server/api.ts:414 returns when diagnostics are unwired. Task 6's copy map keys
  // off this message, so the string is a contract between the two.
  it("rejects a 503 with the message the error copy matches on", async () => {
    stubFetch(503, { error: { code: "unavailable" } });
    await expect(api.diagnostics.refresh()).rejects.toThrow("HTTP 503");
  });
});

// The board branches on `code`, not on the message: a close that answers "the pane is already gone"
// is the END STATE, while "the pane now belongs to someone else" is a real refusal. If the client
// stopped carrying the code, every such close would look like a failure again — and the UI tests,
// which build their own ApiError, would not notice. This is the only test on the extraction itself.
describe("api error codes", () => {
  it("carries the server's error.code onto the rejection", async () => {
    stubFetch(404, { error: { code: "no_live_pane", message: "pane is not live — nothing to close" } });
    await expect(api.tasks.close("b1", "t1", "work-local", "w1:p0", null))
      .rejects.toMatchObject({ code: "no_live_pane", message: "pane is not live — nothing to close" });
  });

  it("leaves the code null when the body carries none", async () => {
    stubFetch(404, {});
    await expect(api.tasks.close("b1", "t1", "work-local", "w1:p0", null))
      .rejects.toMatchObject({ code: null, message: "HTTP 404" });
  });
});

// The one client path every other session's log text enters through. The component tests mock
// `api.boards.get` itself, so only here does `BoardSchema.parse` actually run — an unparsed
// `req<Board>` would leave every other test green.
describe("api.boards.get — the one log-carrying route is parsed, not trusted", () => {
  const task = { id: "t1", title: "T", status: "c1", createdAt: 0, updatedAt: 0 };
  const board = (log: unknown) => ({ id: "b1", label: "B", columns: [], tasks: [{ ...task, log }] });

  it("GETs the board and hands back its log, healing an entry stored without an id", async () => {
    stubFetch(200, board([{ atMs: 5, source: "corral", kind: "created", text: "x" }]));
    const parsed = await api.boards.get("b1");
    expect(calls[0]?.url).toBe("/api/boards/b1");
    expect(parsed.tasks[0]?.log[0]?.text).toBe("x");
    expect(typeof parsed.tasks[0]?.log[0]?.id).toBe("string");
  });

  it("rejects a body whose log entry is not an entry — a wrong kind never reaches the tab", async () => {
    stubFetch(200, board([{ atMs: "soon", source: "corral", kind: "exploded", text: "x" }]));
    await expect(api.boards.get("b1")).rejects.toThrow();
  });
});
