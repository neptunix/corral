// test/diagnostics-schema.test.ts
import {
  CheckSchema, checkKey, computeRollup, EMPTY_DIAGNOSTICS, emptyDiagnostics, type Check,
} from "@shared/diagnostics-schema";
import { describe, it, expect } from "vitest";

const check = (over: Partial<Check>): Check => ({
  id: "x", key: "x", title: "X", state: "ok", severity: "info", detail: "",
  doc: null, scope: { kind: "global" }, class: "cheap", checkedAt: 1,
  startupOkLine: false, haltsStartup: false,
  ...over,
});

describe("checkKey", () => {
  it("separates the same subject in two config dirs — the id alone collides", () => {
    const a = checkKey("capture-script", { kind: "configDir", envId: "work", dir: "/h/.claude" });
    const b = checkKey("capture-script", { kind: "configDir", envId: "work", dir: "/h/.claude-x" });
    expect(a).not.toBe(b);
  });

  it("separates the same subject in two environments", () => {
    expect(checkKey("jq-present", { kind: "env", envId: "a" }))
      .not.toBe(checkKey("jq-present", { kind: "env", envId: "b" }));
  });

  it("is stable for the same id and scope", () => {
    const s = { kind: "env", envId: "work" } as const;
    expect(checkKey("jq-present", s)).toBe(checkKey("jq-present", s));
  });

  it("keeps a global check's key equal to its id", () => {
    expect(checkKey("node-version", { kind: "global" })).toBe("node-version");
  });

  it("separates two global rows of the same subject through the suffix — the missing-binary case", () => {
    const a = checkKey("bin-on-path", { kind: "global" }, "herdr");
    const b = checkKey("bin-on-path", { kind: "global" }, "ssh");
    expect(a).not.toBe(b);
    expect(a).toContain("bin-on-path"); // the id stays the stable subject; only the key varies
  });
});

describe("computeRollup", () => {
  it("counts only problems, split by severity", () => {
    const r = computeRollup([
      check({ state: "problem", severity: "fatal" }),
      check({ state: "problem", severity: "warning" }),
      check({ state: "problem", severity: "info" }),
      check({ state: "ok", severity: "fatal" }),
    ]);
    expect(r).toEqual({ fatal: 1, warning: 1, info: 1, pending: 0 });
  });

  it("counts pending regardless of severity, and never as a problem", () => {
    expect(computeRollup([check({ state: "pending", severity: "fatal", checkedAt: null })]))
      .toEqual({ fatal: 0, warning: 0, info: 0, pending: 1 });
  });

  it("does not count n/a at all — it is neither a problem nor a pass", () => {
    expect(computeRollup([check({ state: "n/a", severity: "warning" })]))
      .toEqual({ fatal: 0, warning: 0, info: 0, pending: 0 });
  });
});

describe("CheckSchema", () => {
  it("rejects an unknown state and an unknown class", () => {
    expect(CheckSchema.safeParse({ ...check({}), state: "broken" }).success).toBe(false);
    expect(CheckSchema.safeParse({ ...check({}), class: "expensive" }).success).toBe(false);
  });

  it("accepts the four cost classes", () => {
    for (const c of ["cheap", "versions", "remote", "network"]) {
      expect(CheckSchema.safeParse({ ...check({}), class: c }).success).toBe(true);
    }
  });

  it("rejects an env scope missing its envId — the discriminated union is the guard", () => {
    expect(CheckSchema.safeParse({ ...check({}), scope: { kind: "env" } }).success).toBe(false);
  });
});

describe("EMPTY_DIAGNOSTICS", () => {
  it("says nothing has answered yet, so an empty snapshot cannot read as healthy", () => {
    expect(EMPTY_DIAGNOSTICS.answered).toEqual([]);
    expect(EMPTY_DIAGNOSTICS.checks).toEqual([]);
    expect(EMPTY_DIAGNOSTICS.rollup).toEqual({ fatal: 0, warning: 0, info: 0, pending: 0 });
    expect(EMPTY_DIAGNOSTICS.self.version).toBe(null);
    expect(EMPTY_DIAGNOSTICS.lastError).toBe(null);
  });

  it("hands out a fresh object each time — the schema default must not alias one snapshot", () => {
    const a = emptyDiagnostics();
    const b = emptyDiagnostics();
    expect(a).toEqual(EMPTY_DIAGNOSTICS);
    expect(a.checks).not.toBe(b.checks);
  });
});
