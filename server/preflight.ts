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
 * Resolve a command name the way execvp does: a name containing a path separator is used verbatim
 * (no PATH search), otherwise each PATH entry is tried in order and the first executable wins. Empty
 * PATH entries are skipped rather than treated as the cwd — resolution must not depend on where the
 * server was started. `isExecutable` is injected so this is testable without touching the filesystem.
 */
export function resolveOnPath(
  bin: string,
  pathEnv: string,
  isExecutable: (p: string) => boolean,
): string | null {
  if (bin.includes(path.sep)) return isExecutable(bin) ? bin : null;
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
