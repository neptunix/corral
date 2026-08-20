import type { Check } from "@shared/diagnostics-schema";

/** Moved here from preflight.ts, which now re-exports it: imports run one way, preflight → diagnostics. */
export interface ReportLine {
  readonly level: "ok" | "warning" | "fatal";
  readonly text: string;
  readonly detail?: string;
}

/**
 * The startup projection of the check set. Problems always print; a healthy check prints only if it
 * asked to, which keeps the launch report as terse as it is today while still naming any new failure.
 * `pending` and `n/a` never print — the report must claim nothing it did not check.
 *
 * The level comes from `haltsStartup`, NOT from `severity`. Severity is the panel's verdict:
 * `bin-on-path` and `jq-present` are fatal there and must stay ⚠ here, because refusing to boot on
 * either would turn a degraded install into no install at all. The report has no `info` mark, so an
 * info problem prints ⚠ as well.
 */
export function toReportLines(checks: readonly Check[]): ReportLine[] {
  const lines: ReportLine[] = [];
  for (const c of checks) {
    if (c.state === "problem") {
      lines.push({
        level: c.haltsStartup ? "fatal" : "warning",
        text: c.title,
        ...(c.detail === "" ? {} : { detail: c.detail }),
      });
      continue;
    }
    if (c.state === "ok" && c.startupOkLine) lines.push({ level: "ok", text: c.title });
  }
  return lines;
}

/** Whether the launch must stop. Only a FAILING check that declares it halts. */
export function haltsLaunch(checks: readonly Check[]): boolean {
  return checks.some((c) => c.haltsStartup && c.state === "problem");
}
