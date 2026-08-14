import type { Check } from "@shared/diagnostics-schema";
import { describe, it, expect } from "vitest";

import { haltsLaunch, toReportLines } from "../server/diagnostics/render.ts";

const check = (over: Partial<Check>): Check => ({
  id: "x", key: "x", title: "X", state: "ok", severity: "info", detail: "",
  doc: null, scope: { kind: "global" }, class: "cheap", checkedAt: 1,
  startupOkLine: false, haltsStartup: false,
  ...over,
});

describe("toReportLines — the mark comes from haltsStartup, not severity", () => {
  it("prints ⚠ for a fatal problem that does not halt — the missing-binary case", () => {
    const [line] = toReportLines([check({ state: "problem", severity: "fatal", haltsStartup: false })]);
    expect(line?.level).toBe("warning");
  });

  it("prints ✗ only for a problem that halts the launch", () => {
    const [line] = toReportLines([check({ state: "problem", severity: "fatal", haltsStartup: true })]);
    expect(line?.level).toBe("fatal");
  });

  it("prints ⚠ for an info problem — the report has no info mark", () => {
    const [line] = toReportLines([check({ state: "problem", severity: "info" })]);
    expect(line?.level).toBe("warning");
  });

  it("prints every problem, whatever its severity", () => {
    const lines = toReportLines([
      check({ title: "a broke", state: "problem", severity: "fatal" }),
      check({ title: "b is odd", state: "problem", severity: "warning" }),
      check({ title: "c suggests", state: "problem", severity: "info" }),
    ]);
    expect(lines.map((l) => l.text)).toEqual(["a broke", "b is odd", "c suggests"]);
  });

  it("prints a healthy check only when it asks for a startup line", () => {
    const lines = toReportLines([
      check({ title: "herdr resolved on PATH", startupOkLine: true }),
      check({ title: "theme installed" }),
    ]);
    expect(lines.map((l) => l.text)).toEqual(["herdr resolved on PATH"]);
  });

  it("omits pending and n/a entirely — the report must claim nothing it did not check", () => {
    expect(toReportLines([
      check({ state: "pending", checkedAt: null, startupOkLine: true }),
      check({ state: "n/a", startupOkLine: true }),
    ])).toEqual([]);
  });

  it("carries detail through, and omits the key when detail is empty", () => {
    const [withDetail] = toReportLines([check({ state: "problem", detail: "PATH: /bin" })]);
    expect(withDetail?.detail).toBe("PATH: /bin");
    const [without] = toReportLines([check({ state: "problem", detail: "" })]);
    expect(without).not.toHaveProperty("detail");
  });
});

describe("haltsLaunch", () => {
  it("halts on a failing check that declares it", () => {
    expect(haltsLaunch([check({ state: "problem", haltsStartup: true })])).toBe(true);
  });

  it("does NOT halt on a fatal check that does not declare it — a missing jq must not block the boot", () => {
    expect(haltsLaunch([check({ id: "jq-present", state: "problem", severity: "fatal" })])).toBe(false);
  });

  it("does not halt when the halting check is healthy, pending, or n/a", () => {
    expect(haltsLaunch([check({ haltsStartup: true })])).toBe(false);
    expect(haltsLaunch([check({ state: "pending", checkedAt: null, haltsStartup: true })])).toBe(false);
    expect(haltsLaunch([check({ state: "n/a", haltsStartup: true })])).toBe(false);
  });
});
