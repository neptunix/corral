import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

import type { HerdrEnv } from "../environments.ts";

/**
 * Startup check that the binaries corral will actually exec are resolvable FROM THE SERVER PROCESS.
 *
 * Why this exists: `buildExec`/`buildAttachSpec` hand a BARE command name (`herdr`, `ssh`) to
 * execFile and node-pty, so resolution falls to whatever PATH the server happened to inherit. A
 * server started from a non-interactive shell (`bash -c`, cron, systemd, an agent, a pane that never
 * sourced a profile) does not get `~/.local/bin` — and then corral looks entirely healthy while
 * nothing works: the board renders from stored data, every card is frozen, and attach dies instantly
 * with `execvp(3) failed.: No such file or directory` inside the terminal modal. Nothing names the
 * binary and nothing names PATH. Worse, the operator's own shell resolves it fine, so the tell lives
 * only in the SERVER's environment — which is why this check must run here and report that PATH.
 *
 * The failure is diagnosed but invisible: pollEnv already records `{ reachable: false, error }` per
 * env, and that state already reaches the client on the wire — the web just never renders it. Until
 * it does, this startup line is the only thing that says the word `herdr` out loud.
 */
export interface MissingBinary {
  readonly bin: string;
  readonly envIds: readonly string[];
}

/** True when `p` is a regular file the current process may execute. */
export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a bare command name against PATH: each entry is tried in order and the first executable
 * wins. Empty PATH entries are skipped rather than treated as the cwd — resolution must not depend on
 * where the server was started. `isExecutable` is injected so the walk is testable without a
 * filesystem (`isExecutableFile` above has its own filesystem-backed tests).
 *
 * There is no verbatim branch for a name containing a separator: the only names reaching here are the
 * literals `findMissingBinaries` produces, and neither contains one. Add it back alongside whatever
 * makes a path-bearing name possible — a configurable local `herdrBin` would.
 */
export function resolveOnPath(
  bin: string,
  pathEnv: string,
  isExecutable: (p: string) => boolean,
): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Which binaries the configured environments need locally, and which of those do not resolve.
 * `local` needs `herdr` on this machine; `remote` needs `ssh` here — its `herdrBin` runs on the far
 * side and cannot be checked without a round trip, so it is deliberately out of scope.
 */
export function findMissingBinaries(
  envs: readonly HerdrEnv[],
  resolve: (bin: string) => string | null,
): MissingBinary[] {
  const needed = new Map<string, string[]>();
  for (const env of envs) {
    const bin = env.kind === "remote" ? "ssh" : "herdr";
    const ids = needed.get(bin);
    if (ids === undefined) needed.set(bin, [env.id]);
    else ids.push(env.id);
  }
  return [...needed.entries()]
    .filter(([bin]) => resolve(bin) === null)
    .map(([bin, envIds]) => ({ bin, envIds }));
}

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

export interface ReportLine {
  readonly level: "ok" | "warning" | "fatal";
  readonly text: string;
  readonly detail?: string;
}

export interface BuildReportInput {
  readonly env: NodeJS.ProcessEnv;
  /** null when the config failed to load — nothing is known about the environments. */
  readonly envs: readonly HerdrEnv[] | null;
  readonly configLine: ReportLine;
  readonly missing: readonly MissingBinary[];
  readonly pathEnv: string;
}

const UNDER_CLAUDE_FATAL =
  "corral passes its whole environment to every child process, so every herdr call and every " +
  "live-terminal attach would carry this Claude session's variables.";

const UNDER_CLAUDE_FIX =
  "fix: CORRAL_ALLOW_UNDER_CLAUDE=1 npm run dev   (this launch only)\n" +
  "     or launch corral from a terminal outside Claude Code";

function unpinnedLocalIds(envs: readonly HerdrEnv[]): string[] {
  return envs.filter((e) => e.kind === "local" && e.socket === undefined).map((e) => e.id);
}

function launchLine(env: NodeJS.ProcessEnv, envs: readonly HerdrEnv[] | null): ReportLine {
  if (env.CLAUDECODE === undefined) return { level: "ok", text: "not running under Claude Code" };

  const unpinned = envs === null ? [] : unpinnedLocalIds(envs);
  // Only assert the wrong-fleet consequence when it is actually reachable: CLAUDECODE is set for every
  // Claude process tree, including headless runs that inherit no socket at all.
  const consequence =
    env.HERDR_SOCKET_PATH !== undefined && unpinned.length > 0
      ? `\n\nHERDR_SOCKET_PATH is set here, and environment(s) ${unpinned.join(", ")} have no ` +
        `explicit "socket" — they would follow this pane's herdr, not the one you meant.`
      : "";

  return {
    // Exact match, not presence: CORRAL_ALLOW_UNDER_CLAUDE=0 must not disable the guard.
    level: env.CORRAL_ALLOW_UNDER_CLAUDE === "1" ? "warning" : "fatal",
    text: "launched from inside a Claude Code session",
    detail: `${UNDER_CLAUDE_FATAL}${consequence}\n\n${UNDER_CLAUDE_FIX}`,
  };
}

function socketLines(env: NodeJS.ProcessEnv, envs: readonly HerdrEnv[]): ReportLine[] {
  const unpinned = unpinnedLocalIds(envs);
  if (unpinned.length === 0) return [];
  const ids = unpinned.join(", ");
  return env.HERDR_SOCKET_PATH === undefined
    ? [{
        level: "warning",
        text: `HERDR_SOCKET_PATH is unset — environment(s) ${ids} inherit the ambient socket`,
        detail:
          "They may return no sessions or route to the wrong herdr instance. Launch from the " +
          "intended herdr context or set HERDR_SOCKET_PATH.",
      }]
    : [{
        level: "warning",
        text: `environment(s) ${ids} unpinned — they will use HERDR_SOCKET_PATH from this shell`,
        detail: `HERDR_SOCKET_PATH=${env.HERDR_SOCKET_PATH}`,
      }];
}

/**
 * The whole report, assembled in one place. Splitting line production across functions that then have
 * to be merged in the right order is how the socket paragraph ended up needing data its producer was
 * never given — every line here sees the same inputs.
 */
export function buildReport(input: BuildReportInput): { lines: readonly ReportLine[]; fatal: boolean } {
  const lines: ReportLine[] = [launchLine(input.env, input.envs)];

  // Announced on every launch, not just once: the likeliest way this guard dies is the operator
  // exporting the override into a shell profile and silently living without it.
  if (input.env.CLAUDECODE !== undefined && input.env.CORRAL_ALLOW_UNDER_CLAUDE === "1") {
    lines.push({ level: "warning", text: "CORRAL_ALLOW_UNDER_CLAUDE=1 — the under-Claude guard is disabled" });
  }
  lines.push(input.configLine);

  if (input.envs !== null) {
    // Missing binaries are a WARNING, never fatal — server/index.ts:35-40 argues it and the argument
    // holds: refusing to boot would turn a degraded deployment into a dead one.
    if (input.missing.length === 0) {
      lines.push({ level: "ok", text: "herdr, ssh resolved on PATH" });
    }
    for (const m of input.missing) {
      lines.push({ level: "warning", text: missingBinaryMessage(m, input.pathEnv) });
    }
    lines.push(...socketLines(input.env, input.envs));
  }

  return { lines, fatal: lines.some((l) => l.level === "fatal") };
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

export function formatReport(lines: readonly ReportLine[]): string {
  const body = lines.flatMap((l) => {
    const head = `  ${MARK[l.level]} ${l.text}`;
    if (l.detail === undefined) return [head];
    return [head, ...l.detail.split("\n").map((d) => (d === "" ? "" : `        ${d}`))];
  });
  return ["corral preflight", ...body].join("\n");
}

export function printReport(text: string): void {
  console.error(text);
}

/** One actionable line. The PATH is the load-bearing part — see the note on MissingBinary. */
export function missingBinaryMessage(missing: MissingBinary, pathEnv: string): string {
  return (
    `[preflight] "${missing.bin}" is not on this server process's PATH, so environment(s) ` +
    `${missing.envIds.join(", ")} cannot list sessions and every live-terminal attach will fail ` +
    `immediately. PATH searched: ${pathEnv}. Fix the PATH the server is launched with (a ` +
    `non-interactive shell does not read your profile) or install "${missing.bin}" into one of those ` +
    `directories.`
  );
}
