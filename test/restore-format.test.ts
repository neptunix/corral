import type { FleetRestoreReport } from "@shared/schema";
import { describe, expect, it } from "vitest";

import { formatRestoreReport, parseRestoreArgs, stripControl } from "../server/restore-format.ts";

describe("parseRestoreArgs", () => {
  it("parses flags in any combination", () => {
    expect(parseRestoreArgs([])).toEqual({ dryRun: false, env: null });
    expect(parseRestoreArgs(["--dry-run"])).toEqual({ dryRun: true, env: null });
    expect(parseRestoreArgs(["--env", "e1", "--dry-run"])).toEqual({ dryRun: true, env: "e1" });
  });
  it("rejects a dangling --env and unknown flags", () => {
    expect(parseRestoreArgs(["--env"])).toHaveProperty("error");
    expect(parseRestoreArgs(["--env", "--dry-run"])).toHaveProperty("error");
    expect(parseRestoreArgs(["--wat"])).toHaveProperty("error");
  });
});

describe("stripControl", () => {
  it("drops C0/C1 controls and ESC-initiated sequences, keeps the text", () => {
    expect(stripControl(`a${String.fromCharCode(0x1b)}[31mred${String.fromCharCode(0x1b)}[0mb`)).toBe("aredb");
    expect(stripControl(`t${String.fromCharCode(0x1b)}]0;evil title${String.fromCharCode(0x07)}x`)).toBe("tx");
    expect(stripControl(`bell${String.fromCharCode(0x07)} tab\t nl\n c1${String.fromCharCode(0x9b)} end`)).toBe("bell tab nl c1 end");
  });
});

function report(over?: Partial<FleetRestoreReport>): FleetRestoreReport {
  return {
    dryRun: false,
    envs: {
      e1: {
        error: null, updatedAt: 1000, unmirrored: 0,
        sessions: [
          { sessionId: "aaaaaaaa-0000-4000-8000-000000000001", name: "ok-tab", outcome: "resumed", error: null },
          { sessionId: "bbbbbbbb-0000-4000-8000-000000000002", name: `bad${String.fromCharCode(0x1b)}[2Jtab`, outcome: "failed", error: "spawn: pane run failed" },
        ],
      },
    },
    ...over,
  };
}

describe("formatRestoreReport", () => {
  it("exit 1 on any failed session or env error; failures printed sanitized", () => {
    const { text, exitCode } = formatRestoreReport(report(), 1600);
    expect(exitCode).toBe(1);
    expect(text).toContain("resumed 1");
    expect(text).toContain("failed 1");
    expect(text).toContain("badtab"); // ESC sequence stripped
    expect(text).not.toContain(String.fromCharCode(0x1b));
  });

  it("exit 0 on a clean report; dry run surfaces a nonzero unmirrored count as the do-not-kill-herdr warning", () => {
    const clean = formatRestoreReport({ dryRun: false, envs: { e1: { error: null, updatedAt: 1000, unmirrored: 0, sessions: [] } } }, 1600);
    expect(clean.exitCode).toBe(0);
    const dry = formatRestoreReport({ dryRun: true, envs: { e1: { error: null, updatedAt: 1000, unmirrored: 3, sessions: [] } } }, 1600);
    expect(dry.exitCode).toBe(0);
    expect(dry.text).toContain("unmirrored 3");
    expect(dry.text.toLowerCase()).toContain("do not kill herdr");
  });

  it("env error → exit 1 and the error line, sanitized", () => {
    const r = formatRestoreReport({ dryRun: false, envs: { e1: { error: "not_in_mirror", updatedAt: null, unmirrored: 0, sessions: [] } } }, 1600);
    expect(r.exitCode).toBe(1);
    expect(r.text).toContain("not_in_mirror");
  });
});
