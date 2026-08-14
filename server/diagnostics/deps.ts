import { accessSync, constants, statSync } from "node:fs";
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
