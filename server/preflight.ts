import { ENV_CONFIG_PATH } from "../config.ts";
import type { HerdrEnv } from "../environments.ts";
import { isExecutableFile, resolveOnPath } from "./diagnostics/deps.ts";
import type { ReportLine } from "./diagnostics/render.ts";
import { haltsLaunch, toReportLines } from "./diagnostics/render.ts";
import type { BuildReportInput } from "./diagnostics/startup.ts";
import { buildStartupChecks, findMissingBinaries } from "./diagnostics/startup.ts";

export type { ReportLine } from "./diagnostics/render.ts";
export type { MissingBinary } from "./diagnostics/startup.ts";
export { findMissingBinaries, missingBinaryMessage } from "./diagnostics/startup.ts";
export { isExecutableFile, resolveOnPath } from "./diagnostics/deps.ts";

/**
 * Floor for the zombie reaper's grace window (ZOMBIE_REAP_GRACE_MS), clamped UP at startup so a
 * too-short grace degrades into slower cleanup instead of refusing to boot.
 *
 * A pane's liveness in a poller snapshot is at most `pollMs + listTimeoutMs` old — one staleness
 * window. The grace must outlast two of them: while the poll loop is ticking on schedule that is long
 * enough for a refuting poll to land and reset the clock (detectZombies rebuilds `since` from the
 * round's candidates), so a single stale sighting cannot reap a live pane. A stopped poll loop is a
 * separate case, handled by the tick-gap rail in zombie-reaper.ts.
 */
export function resolveReapGrace(
  configuredMs: number,
  pollMs: number,
  listTimeoutMs: number,
): { readonly ms: number; readonly message: string | null } {
  const floor = 2 * (pollMs + listTimeoutMs); // two staleness windows
  if (configuredMs >= floor) return { ms: configuredMs, message: null };
  return {
    ms: floor,
    message:
      `[preflight] ZOMBIE_REAP_GRACE_MS=${String(configuredMs)} is below the ${String(floor)} ms ` +
      `floor implied by HERDR_DASH_POLL_MS=${String(pollMs)}; using ${String(floor)} ms. A shorter ` +
      `grace lets the zombie reaper close a pane whose just-spawned Claude it has not polled yet, ` +
      `killing a live session.`,
  };
}

export function buildReport(input: BuildReportInput): { lines: readonly ReportLine[]; fatal: boolean } {
  const checks = buildStartupChecks(input);
  return { lines: toReportLines(checks), fatal: haltsLaunch(checks) };
}

export async function loadEnvironmentsOrReport(
  load: () => Promise<readonly HerdrEnv[]>,
  configPath: string,
): Promise<
  | { ok: true; envs: readonly HerdrEnv[]; line: ReportLine }
  | { ok: false; line: ReportLine }
> {
  try {
    const envs = await load();
    return {
      ok: true,
      envs,
      // configPath verbatim: CORRAL_CONFIG is used unexpanded (config.ts:29-30), so claiming an
      // absolute path would be a lie for anyone who overrode it.
      line: { level: "ok", text: `config: ${String(envs.length)} environment(s) loaded from ${configPath}` },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, line: { level: "fatal", text: `config: ${msg}` } };
  }
}

const MARK = { ok: "✓", warning: "⚠", fatal: "✗" } as const;

const indent = (s: string, pad: string): string[] =>
  s.split("\n").map((line, i) => (i === 0 || line === "" ? line : `${pad}${line}`));

export function formatReport(lines: readonly ReportLine[]): string {
  const body = lines.flatMap((l) => {
    // A Zod config error is multi-line; without indenting continuations it breaks the report's shape.
    const head = indent(`  ${MARK[l.level]} ${l.text}`, "      ");
    if (l.detail === undefined) return head;
    return [...head, ...l.detail.split("\n").map((d) => (d === "" ? "" : `        ${d}`))];
  });
  return ["corral preflight", ...body].join("\n");
}

/**
 * The whole preflight, as both entrypoints need it. Exported so `scripts/preflight.ts` and
 * `server/index.ts` cannot drift: a check added here fires on every launch path, and one added to only
 * one caller would silently stop guarding the path it was written for.
 *
 * Takes no arguments on purpose. A `configPath` parameter could only ever label the report — the file
 * actually read is fixed by environments.ts at module scope — so a caller passing a different one
 * would make the report name a file that was never opened.
 *
 * The dynamic import is load-bearing — environments.ts evaluates ENVIRONMENTS at module scope, so a
 * static import throws during resolution, before any of this can turn it into a readable line.
 *
 * Returns `configLine` alongside the report: a later sweep needs the same load result and must not
 * import environments.ts a second time to get it — the module is evaluated once at module scope, so a
 * second import returns the same result and only creates the illusion of a fresh read.
 */
export async function runPreflight(): Promise<{
  report: { lines: readonly ReportLine[]; fatal: boolean };
  envs: readonly HerdrEnv[] | null;
  configLine: ReportLine;
}> {
  const env = process.env;
  const pathEnv = env.PATH ?? "";
  const cfg = await loadEnvironmentsOrReport(
    async () => (await import("../environments.ts")).ENVIRONMENTS,
    ENV_CONFIG_PATH,
  );
  const report = buildReport({
    env,
    envs: cfg.ok ? cfg.envs : null,
    configLine: cfg.line,
    missing: cfg.ok ? findMissingBinaries(cfg.envs, (bin) => resolveOnPath(bin, pathEnv, isExecutableFile)) : [],
    pathEnv,
  });
  return { report, envs: cfg.ok ? cfg.envs : null, configLine: cfg.line };
}
