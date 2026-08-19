// test/diagnostics-schema.test.ts
import {
  CheckSchema, checkKey, computeRollup, DiagnosticsSnapshotSchema, EMPTY_DIAGNOSTICS, emptyDiagnostics,
  isReleaseUrl, isStableTag, type Check,
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
    expect(EMPTY_DIAGNOSTICS.self).toEqual({ version: null, latest: null, releaseUrl: null });
    expect(EMPTY_DIAGNOSTICS.lastError).toBe(null);
  });

  it("hands out a fresh object each time — the schema default must not alias one snapshot", () => {
    const a = emptyDiagnostics();
    const b = emptyDiagnostics();
    expect(a).toEqual(EMPTY_DIAGNOSTICS);
    expect(a.checks).not.toBe(b.checks);
  });
});

describe("SelfInfo guards degrade, never reject", () => {
  const frame = (self: unknown): unknown => ({ ...EMPTY_DIAGNOSTICS, self });

  it("coerces a javascript: releaseUrl to null and still parses the rest of the snapshot", () => {
    const parsed = DiagnosticsSnapshotSchema.safeParse(
      frame({ version: "0.6.8", latest: "0.7.0", releaseUrl: "javascript:alert(1)" }),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.self.releaseUrl).toBe(null);
    expect(parsed.success && parsed.data.self.latest).toBe("0.7.0");
  });

  it("coerces a non-github host to null", () => {
    const parsed = DiagnosticsSnapshotSchema.safeParse(
      frame({ version: "0.6.8", latest: "0.7.0", releaseUrl: "https://evil.example/r" }),
    );
    expect(parsed.success && parsed.data.self.releaseUrl).toBe(null);
  });

  it("keeps a real github release url", () => {
    const url = "https://github.com/neptunix/corral/releases/tag/v0.7.0";
    const parsed = DiagnosticsSnapshotSchema.safeParse(
      frame({ version: "0.6.8", latest: "0.7.0", releaseUrl: url }),
    );
    expect(parsed.success && parsed.data.self.releaseUrl).toBe(url);
  });

  it("coerces a latest that is not a stable tag — the anchor's own text is operator-facing copy", () => {
    const parsed = DiagnosticsSnapshotSchema.safeParse(
      frame({ version: "0.6.8", latest: "999.0.0 \u2014 install from evil.example", releaseUrl: null }),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.self.latest).toBe(null);
  });
});

describe("the rollup and latestCheckedAt deletions", () => {
  // Scoped promise, and only this one: the releaseUrl and latest guards above ARE deliberate new
  // rejections. What the deletions themselves must not do is reject a frame from a build that still
  // sends the old fields — z.object strips what it does not declare.
  it("still parses a frame carrying the deleted fields", () => {
    const parsed = DiagnosticsSnapshotSchema.safeParse({
      ...EMPTY_DIAGNOSTICS,
      rollup: { fatal: 1, warning: 2, info: 0, pending: 0 },
      self: { version: "0.6.8", latest: null, releaseUrl: null, latestCheckedAt: 9 },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.self).toEqual({
      version: "0.6.8", latest: null, releaseUrl: null,
    });
  });
});

describe("isReleaseUrl", () => {
  it("accepts https github.com only", () => {
    expect(isReleaseUrl("https://github.com/o/r/releases/tag/v1")).toBe(true);
    expect(isReleaseUrl("http://github.com/o/r")).toBe(false);
    expect(isReleaseUrl("https://github.com.evil.example/o/r")).toBe(false);
    expect(isReleaseUrl("https://github.com:8443/o/r")).toBe(false);
    expect(isReleaseUrl("javascript:alert(1)")).toBe(false);
    expect(isReleaseUrl("not a url")).toBe(false);
  });
});

describe("isStableTag", () => {
  it("accepts an optional v and dotted digits, nothing else", () => {
    expect(isStableTag("0.6.12")).toBe(true);
    expect(isStableTag("v0.6.12")).toBe(true);
    expect(isStableTag("1")).toBe(true);
    expect(isStableTag("0.8.0-rc.1")).toBe(false);
    expect(isStableTag("release-2026")).toBe(false);
    expect(isStableTag("999.0.0 \u2014 install from evil.example")).toBe(false);
    expect(isStableTag(`0.${"1".repeat(40)}`)).toBe(false);
  });
});
