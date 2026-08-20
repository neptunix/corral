import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import path from "node:path";

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
 * Every filesystem/process fact a check might need, gathered behind one injectable seam so a check
 * itself never touches `node:fs`/`node:child_process`/`process` directly and a test never needs an
 * env-var escape hatch to vary one.
 */
export interface CheckDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly pathEnv: string;
  /** Injected, so no check reads process.versions directly and no test needs an env-var escape hatch. */
  readonly nodeVersion: string;
  readonly isFile: (p: string) => boolean;
  readonly isExec: (p: string) => boolean;
  readonly isDir: (p: string) => boolean;
  /** Contents of a REGULAR file up to the size cap; null otherwise. Never throws, never blocks. */
  readonly readText: (p: string) => string | null;
  /** sha256 hex of a regular file, or null. */
  readonly hashFile: (p: string) => string | null;
  readonly repoRoot: string;
  readonly now: () => number;
}

/** Where a locally-installed tool tends to live even when the server's own PATH does not include it. */
export const STANDARD_BIN_DIRS: readonly string[] = [
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/local/bin",
];

export interface ToolLocation {
  readonly path: string | null;
  readonly onServerPath: boolean;
}

/**
 * Locate `bin` the way the server actually would (PATH first, via `resolveOnPath`), then fall back to
 * `STANDARD_BIN_DIRS` so "installed, but not where this server would find it" is reported as its own
 * state rather than folded into either "found" or "absent".
 */
export function locateTool(bin: string, deps: CheckDeps): ToolLocation {
  const onPath = resolveOnPath(bin, deps.pathEnv, deps.isExec);
  if (onPath !== null) return { path: onPath, onServerPath: true };
  for (const dir of STANDARD_BIN_DIRS) {
    const candidate = path.join(dir, bin);
    if (deps.isExec(candidate)) return { path: candidate, onServerPath: false };
  }
  return { path: null, onServerPath: false };
}

/** Interpreters a launch command may be prefixed with — none of these is ever the thing being checked. */
const KNOWN_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "node", "python", "python3"]);

/**
 * Pick the script/binary out of a launch command such as `bash ~/.claude/statusline-command.sh --json`:
 * the FIRST token that is neither a known interpreter nor a flag, so trailing arguments never make a
 * healthy command look like a missing one. Taking the LAST token instead was an earlier draft's rule —
 * it reads `statusline-command.sh --json` as a missing `--json` binary, a warning no operator can act
 * on.
 */
export function resolveCommandPath(command: string, home: string | undefined): string {
  const tokens = command.trim().split(/\s+/).filter((t) => t !== "");
  const token = tokens.find((t) => !KNOWN_INTERPRETERS.has(t) && !t.startsWith("-"));
  if (token === undefined) return "";
  if (home !== undefined && token.startsWith("~/")) return path.join(home, token.slice(2));
  return token;
}

const MAX_READABLE_BYTES = 1_048_576;

/**
 * Shared guard for `readText`/`hashFile`: `statSync` first, require a REGULAR file under the size cap,
 * swallow every error into `null`. `statSync` and the read that follows are two separate syscalls, so
 * a file that changes type between them (a FIFO swapped in, say) is not fully closed off — accepted
 * for stage 1 because both paths come from a trusted local config file on the operator's own machine,
 * not a remote host. Both follow symlinks (the default for `statSync`/`readFileSync`), which is what
 * lets a symlink into the checkout read/hash equal to its source.
 */
function readGuarded<T>(p: string, read: (p: string) => T): T | null {
  try {
    const stat = statSync(p);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_READABLE_BYTES) return null;
    return read(p);
  } catch {
    return null;
  }
}

/** Assembles the real, filesystem-backed `CheckDeps` a running server uses. */
export function createNodeDeps(opts: { repoRoot: string }): CheckDeps {
  return {
    env: process.env,
    pathEnv: process.env.PATH ?? "",
    nodeVersion: process.versions.node,
    isFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    isExec: isExecutableFile,
    isDir: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    readText: (p) => readGuarded(p, (f) => readFileSync(f, "utf8")),
    hashFile: (p) => readGuarded(p, (f) => createHash("sha256").update(readFileSync(f)).digest("hex")),
    repoRoot: opts.repoRoot,
    now: () => Date.now(),
  };
}
