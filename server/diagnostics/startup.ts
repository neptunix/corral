import type { Check } from "@shared/diagnostics-schema";
import { checkKey } from "@shared/diagnostics-schema";

import type { ReportLine } from "./render.ts";
import type { HerdrEnv } from "../../environments.ts";

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
 */
export interface MissingBinary {
  readonly bin: string;
  readonly envIds: readonly string[];
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

const UNDER_CLAUDE_FATAL =
  "corral passes its whole environment to every child process, so every herdr call and every " +
  "live-terminal attach would carry this Claude session's variables.";

const UNDER_CLAUDE_FIX =
  "fix: prefix the launch — CORRAL_ALLOW_UNDER_CLAUDE=1 npm run dev   (or npm start)\n" +
  "     or launch corral from a terminal outside Claude Code";

function unpinnedLocalIds(envs: readonly HerdrEnv[]): string[] {
  return envs.filter((e) => e.kind === "local" && e.socket === undefined).map((e) => e.id);
}

/** An empty socket path behaves exactly like an unset one — herdr.ts passes the value straight through. */
const socketOf = (env: NodeJS.ProcessEnv): string | undefined =>
  env.HERDR_SOCKET_PATH === undefined || env.HERDR_SOCKET_PATH === "" ? undefined : env.HERDR_SOCKET_PATH;

/** Which binaries the configured envs actually make corral exec — the same split findMissingBinaries uses. */
function neededBinaries(envs: readonly HerdrEnv[]): string[] {
  return [...new Set(envs.map((e) => (e.kind === "remote" ? "ssh" : "herdr")))];
}

/**
 * Under-Claude guard, as one or two checks. The mark this produces at startup comes from
 * `haltsStartup`, not `severity` — the override flips `haltsStartup` to false along with the level,
 * which is the one place the two move together, and it is the override's whole purpose.
 */
export function launchChecks(
  env: NodeJS.ProcessEnv, envs: readonly HerdrEnv[] | null, now: number,
): Check[] {
  const scope = { kind: "global" as const };
  const base = {
    scope, class: "cheap" as const, checkedAt: now,
    doc: { anchor: "launching-corral", title: "Launching corral" },
  };
  // Presence is the signal, whatever the value: `CLAUDECODE= npm run dev` would otherwise be a
  // silent escape.
  if (env.CLAUDECODE === undefined) {
    return [{
      ...base, id: "launch-under-claude", key: checkKey("launch-under-claude", scope),
      title: "not running under Claude Code",
      state: "ok", severity: "fatal", detail: "", startupOkLine: true, haltsStartup: true,
    }];
  }
  // Exact match, not presence: CORRAL_ALLOW_UNDER_CLAUDE=0 must not disable the guard.
  const overridden = env.CORRAL_ALLOW_UNDER_CLAUDE === "1";
  const unpinned = envs === null ? [] : unpinnedLocalIds(envs);
  const consequence =
    socketOf(env) !== undefined && unpinned.length > 0
      ? `\n\nHERDR_SOCKET_PATH is set here, and environment(s) ${unpinned.join(", ")} have no ` +
        `explicit "socket" — they would follow this pane's herdr, not the one you meant.`
      : "";
  const checks: Check[] = [{
    ...base, id: "launch-under-claude", key: checkKey("launch-under-claude", scope),
    title: "launched from inside a Claude Code session",
    state: "problem", severity: overridden ? "warning" : "fatal",
    detail: `${UNDER_CLAUDE_FATAL}${consequence}${overridden ? "" : `\n\n${UNDER_CLAUDE_FIX}`}`,
    startupOkLine: true,
    haltsStartup: !overridden,
  }];
  // Repeated on every start, not just once: the likeliest way this guard dies is the operator
  // exporting the override into a shell profile and ceasing to notice.
  if (overridden) {
    checks.push({
      ...base, id: "under-claude-override", key: checkKey("under-claude-override", scope),
      title: "CORRAL_ALLOW_UNDER_CLAUDE=1 — the under-Claude guard is disabled",
      state: "problem", severity: "warning", detail: "", startupOkLine: false, haltsStartup: false,
    });
  }
  return checks;
}

export const missingBinaryTitle = (m: MissingBinary): string =>
  `[preflight] "${m.bin}" is not on this server process's PATH`;

export const missingBinaryDetail = (m: MissingBinary, pathEnv: string): string =>
  `so environment(s) ${m.envIds.join(", ")} cannot list sessions and every live-terminal attach will ` +
  `fail immediately. PATH searched: ${pathEnv}. Fix the PATH the server is launched with (a ` +
  `non-interactive shell does not read your profile) or install "${m.bin}" into one of those directories.`;

/** Kept byte-identical: `test/preflight.test.ts` asserts on it and is not in this task's edits. */
export const missingBinaryMessage = (m: MissingBinary, pathEnv: string): string =>
  `${missingBinaryTitle(m)}, ${missingBinaryDetail(m, pathEnv)}`;

/**
 * `bin-on-path` is a `fatal` verdict in the panel (refusing to boot would turn a degraded deployment
 * into a dead one) — that fixed `severity` is why `haltsStartup: false` here, never following state.
 */
export function binaryChecks(
  envs: readonly HerdrEnv[], missing: readonly MissingBinary[], pathEnv: string, now: number,
): Check[] {
  const scope = { kind: "global" as const };
  const base = {
    scope, class: "cheap" as const, checkedAt: now, haltsStartup: false,
    doc: { anchor: "quick-start", title: "Quick start" },
  };
  // Name only what was actually looked up — an all-local config never searches for ssh, and a green
  // line claiming otherwise is the silent lie this module exists to remove.
  if (missing.length === 0) {
    return [{
      ...base, id: "bin-on-path", key: checkKey("bin-on-path", scope),
      title: `${neededBinaries(envs).join(", ")} resolved on PATH`,
      state: "ok", severity: "fatal", detail: "", startupOkLine: true,
    }];
  }
  // One row per missing binary, all under the SAME id — the id is the subject; the key carries the
  // binary.
  //
  // The whole sentence goes in `title`, with an EMPTY `detail`, deliberately: the startup report must
  // print exactly the lines it printed before this module existed, and `formatReport` renders a
  // non-empty `detail` as a second, indented continuation line. Splitting this into
  // `missingBinaryTitle` + `missingBinaryDetail` would gain the launch report a line. The two halves
  // stay exported for the panel — making that split is stage 2's call, once the rail has a renderer of
  // its own that is not bound by startup parity.
  return missing.map((m) => ({
    ...base, id: "bin-on-path", key: checkKey("bin-on-path", scope, m.bin),
    title: missingBinaryMessage(m, pathEnv),
    state: "problem" as const, severity: "fatal" as const, startupOkLine: false,
    detail: "",
  }));
}

/**
 * Converts the `ReportLine` `loadEnvironmentsOrReport` already returns into the check shape. One
 * conversion, in the module that owns the check shape, so `loadEnvironmentsOrReport` itself never
 * needs to know about `Check`.
 */
export function configLoadCheck(line: ReportLine, now: number): Check {
  const scope = { kind: "global" as const };
  return {
    id: "config-loaded", key: checkKey("config-loaded", scope), scope,
    title: line.text, state: line.level === "ok" ? "ok" : "problem",
    severity: "fatal", detail: line.detail ?? "",
    doc: { anchor: "environments", title: "Environments" },
    class: "cheap", checkedAt: now, startupOkLine: true, haltsStartup: true,
  };
}

/** Whether HERDR_SOCKET_PATH is pinned per-env; never fatal — live state is an enhancement. */
export function socketChecks(
  env: NodeJS.ProcessEnv, envs: readonly HerdrEnv[], now: number,
): Check[] {
  const unpinned = unpinnedLocalIds(envs);
  if (unpinned.length === 0) return [];
  const ids = unpinned.join(", ");
  const socket = socketOf(env);
  const scope = { kind: "global" as const };
  const base = {
    scope, class: "cheap" as const, checkedAt: now, haltsStartup: false,
    severity: "warning" as const, state: "problem" as const, startupOkLine: false,
    doc: { anchor: "launching-corral", title: "Launching corral" },
  };
  if (socket === undefined) {
    return [{
      ...base, id: "socket-ambient", key: checkKey("socket-ambient", scope),
      title: `HERDR_SOCKET_PATH is unset — environment(s) ${ids} inherit the ambient socket`,
      detail:
        "They may return no sessions or route to the wrong herdr instance. Launch from the " +
        "intended herdr context or set HERDR_SOCKET_PATH.",
    }];
  }
  return [{
    ...base, id: "socket-unpinned", key: checkKey("socket-unpinned", scope),
    title: `environment(s) ${ids} unpinned — they will use HERDR_SOCKET_PATH from this shell`,
    detail: `HERDR_SOCKET_PATH=${socket}`,
  }];
}

/**
 * Whether corral can see Claude's session registry per environment. Reads no filesystem — an empty
 * `claudeConfigDirs` is the whole signal, which is what makes live session state and Remote Control
 * not function on that environment at all. A remote env cannot be checked further without an SSH
 * round trip at startup, which would hang the launch on an unreachable box.
 */
export function configDirsChecks(envs: readonly HerdrEnv[], now: number): Check[] {
  const missing = envs.filter((e) => e.claudeConfigDirs.length === 0);
  const base = {
    class: "cheap" as const, checkedAt: now, haltsStartup: false,
    severity: "warning" as const,
    doc: { anchor: "environments", title: "Environments" },
  };
  // A warning, never fatal: live state is an enhancement, and refusing to boot over it would turn a
  // degraded board into no board.
  if (missing.length === 0) {
    if (envs.length === 0) return [];
    const scope = { kind: "global" as const };
    return [{
      ...base, id: "claude-config-dirs", key: checkKey("claude-config-dirs", scope), scope,
      title: "Claude session registry readable in every environment",
      state: "ok", detail: "", startupOkLine: true,
    }];
  }
  return missing.map((e) => {
    const scope = { kind: "env" as const, envId: e.id };
    return {
      ...base, id: "claude-config-dirs", key: checkKey("claude-config-dirs", scope), scope,
      title:
        `registry: environment "${e.id}" — no "claudeConfigDirs" — live session state and Remote ` +
        `Control do not function here`,
      state: "problem" as const, detail: "", startupOkLine: false,
    };
  });
}

export interface BuildReportInput {
  readonly env: NodeJS.ProcessEnv;
  /** null when the config failed to load — nothing is known about the environments. */
  readonly envs: readonly HerdrEnv[] | null;
  readonly configLine: ReportLine;
  readonly missing: readonly MissingBinary[];
  readonly pathEnv: string;
}

/**
 * The whole startup check set, in the order the report has always printed: launch guard, config
 * load, then — only once the environments are known — binaries, socket pinning, and the config-dirs
 * registry line. Nothing else: this is a parity refactor, not a place to add a new check.
 */
export function buildStartupChecks(input: BuildReportInput): Check[] {
  const now = Date.now();
  const checks: Check[] = [
    ...launchChecks(input.env, input.envs, now),
    configLoadCheck(input.configLine, now),
  ];
  if (input.envs !== null) {
    checks.push(
      ...binaryChecks(input.envs, input.missing, input.pathEnv, now),
      ...socketChecks(input.env, input.envs, now),
      ...configDirsChecks(input.envs, now),
    );
  }
  return checks;
}
