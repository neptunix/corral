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
