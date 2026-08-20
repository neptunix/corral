import type { Check } from "@shared/diagnostics-schema";
import { DiagnosticsSnapshotSchema } from "@shared/diagnostics-schema";
import { describe, it, expect } from "vitest";

import { createDiagnosticsStore } from "../server/diagnostics-store.ts";

const check = (over: Partial<Check>): Check => ({
  id: "x", key: "x", title: "X", state: "ok", severity: "info", detail: "",
  doc: null, scope: { kind: "global" }, class: "cheap", checkedAt: 1,
  startupOkLine: false, haltsStartup: false,
  ...over,
});

describe("createDiagnosticsStore", () => {
  it("starts empty, valid, and says nothing has answered", () => {
    const s = createDiagnosticsStore({ selfVersion: "0.6.5" });
    const snap = s.snapshot();
    expect(DiagnosticsSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.answered).toEqual([]);
    expect(snap.self.version).toBe("0.6.5");
  });

  it("records a class as answered even when it produced no rows", () => {
    const s = createDiagnosticsStore({ selfVersion: null });
    s.put("cheap", []);
    expect(s.snapshot().answered).toEqual(["cheap"]);
  });

  it("replaces a class wholesale — a resolved problem must disappear", () => {
    const s = createDiagnosticsStore({ selfVersion: null });
    s.put("cheap", [check({ state: "problem", severity: "fatal" })]);
    s.put("cheap", [check({})]);
    expect(s.snapshot().rollup).toEqual({ fatal: 0, warning: 0, info: 0, pending: 0 });
  });

  it("keeps classes independent — a cheap sweep must not clear version rows", () => {
    const s = createDiagnosticsStore({ selfVersion: null });
    s.put("versions", [check({ id: "n", key: "n", class: "versions" })]);
    s.put("cheap", [check({ id: "c", key: "c" })]);
    expect(s.snapshot().checks.map((c) => c.id).sort()).toEqual(["c", "n"]);
    expect(s.snapshot().answered.sort()).toEqual(["cheap", "versions"]);
  });

  it("recomputes the rollup on every snapshot", () => {
    const s = createDiagnosticsStore({ selfVersion: null });
    s.put("cheap", [
      check({ id: "a", key: "a", state: "problem", severity: "fatal" }),
      check({ id: "b", key: "b", state: "pending", checkedAt: null }),
    ]);
    expect(s.snapshot().rollup).toEqual({ fatal: 1, warning: 0, info: 0, pending: 1 });
  });

  it("carries the last sweep error, and clears it", () => {
    const s = createDiagnosticsStore({ selfVersion: null });
    expect(s.snapshot().lastError).toBe(null);
    s.setLastError("boom");
    expect(s.snapshot().lastError).toBe("boom");
    s.setLastError(null);
    expect(s.snapshot().lastError).toBe(null);
  });

  it("patches self without touching checks", () => {
    const s = createDiagnosticsStore({ selfVersion: "0.6.5" });
    s.put("cheap", [check({})]);
    s.patchSelf({ latest: "0.7.0", releaseUrl: "https://example.test/r", latestCheckedAt: 9 });
    const snap = s.snapshot();
    expect(snap.self).toEqual({ version: "0.6.5", latest: "0.7.0", releaseUrl: "https://example.test/r", latestCheckedAt: 9 });
    expect(snap.checks).toHaveLength(1);
  });
});
