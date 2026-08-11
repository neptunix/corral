import type { FleetRestoreOutcome, FleetRestoreReport } from "@shared/schema";

export interface RestoreCliArgs {
  readonly dryRun: boolean;
  readonly env: string | null;
}

export function parseRestoreArgs(argv: readonly string[]): RestoreCliArgs | { readonly error: string } {
  let dryRun = false;
  let env: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--env") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: "--env requires a value" };
      env = value;
      i += 1;
      continue;
    }
    return { error: `unknown argument: ${arg ?? ""}` };
  }
  return { dryRun, env };
}

/**
 * Drop C0/C1 control characters and ESC-initiated sequences (CSI to its final byte; OSC/DCS to
 * BEL/ST). `name`/`error` are herdr-side strings any pane agent can set, and the CLI is a fresh
 * terminal surface with no escaping in front of it. charCode scan, not a regex — `no-control-regex`
 * (same approach as attachFailureReason in server/ws-attach.ts).
 */
export function stripControl(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      i += 1;
      const intro = text.charCodeAt(i);
      if (intro === 0x5d || intro === 0x50) { // OSC / DCS: string-terminated
        i += 1;
        while (i < text.length) {
          const c = text.charCodeAt(i);
          i += 1;
          if (c === 0x07) break; // BEL
          if (c === 0x1b && text.charCodeAt(i) === 0x5c) { i += 1; break; } // ST
        }
        continue;
      }
      if (intro === 0x5b) i += 1; // '[' of CSI; a two-char escape has no introducer
      while (i < text.length) {
        const c = text.charCodeAt(i);
        i += 1;
        if (c >= 0x40 && c <= 0x7e) break; // final byte
      }
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      i += 1; // C0/C1 dropped outright — names and error messages are single-line labels
      continue;
    }
    out += text.charAt(i);
    i += 1;
  }
  return out;
}

function formatAge(secs: number): string {
  if (secs < 90) return `${String(Math.max(0, Math.round(secs)))}s`;
  if (secs < 5400) return `${String(Math.round(secs / 60))}m`;
  return `${String(Math.round(secs / 3600))}h`;
}

export function formatRestoreReport(
  report: FleetRestoreReport,
  nowSecs: number,
): { readonly text: string; readonly exitCode: 0 | 1 } {
  const lines: string[] = [];
  let exitCode: 0 | 1 = 0;
  const entries = Object.entries(report.envs);
  if (entries.length === 0) {
    return { text: "nothing to restore — no configured environment appears in the mirror", exitCode: 0 };
  }
  for (const [envId, envRep] of entries) {
    const age = envRep.updatedAt === null ? "no mirror entry" : `mirror updated ${formatAge(nowSecs - envRep.updatedAt)} ago`;
    lines.push(`${envId}  (${age})`);
    if (envRep.error !== null) {
      exitCode = 1;
      lines.push(`  ERROR: ${stripControl(envRep.error)}`);
    }
    const counts = new Map<FleetRestoreOutcome, number>();
    for (const s of envRep.sessions) counts.set(s.outcome, (counts.get(s.outcome) ?? 0) + 1);
    const verb: FleetRestoreOutcome = report.dryRun ? "would_resume" : "resumed";
    lines.push(
      `  ${verb} ${String(counts.get(verb) ?? 0)}` +
      `  skipped_alive ${String(counts.get("skipped_alive") ?? 0)}` +
      `  skipped_recent ${String(counts.get("skipped_recent") ?? 0)}` +
      `  failed ${String(counts.get("failed") ?? 0)}` +
      `  unmirrored ${String(envRep.unmirrored)}`,
    );
    for (const s of envRep.sessions) {
      if (s.outcome !== "failed") continue;
      exitCode = 1;
      lines.push(`  FAILED ${s.sessionId}  ${stripControl(s.name)}: ${stripControl(s.error ?? "")}`);
    }
    if (report.dryRun && envRep.unmirrored > 0) {
      lines.push(`  WARNING: ${String(envRep.unmirrored)} live session(s) missing from the mirror — do not kill herdr until a poll has caught up`);
    }
  }
  return { text: lines.join("\n"), exitCode };
}
