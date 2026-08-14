import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Resolved from this module's own location, so it is the package.json of the checkout the server runs
 * from — not the cwd's, which a launch from elsewhere would find instead. `import.meta.dirname` is
 * available from Node 20.11, which is also `engines.node`.
 *
 * `package.json`'s `version` field is the SINGLE source for `SelfInfo.version`, and nothing verifies it
 * against the release tags — bump it in the same commit as the tag, or the diagnostics panel reports a
 * build the operator is not running (and, once `SelfInfo.latest` is wired, a permanent false "update
 * available").
 */
export const PACKAGE_JSON_PATH = path.join(import.meta.dirname, "..", "package.json");

const PackageSchema = z.object({ version: z.string().min(1) });

/** The running corral's version, or null when package.json is unreadable or malformed. Never throws. */
export function readSelfVersion(
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): string | null {
  try {
    const parsed = PackageSchema.safeParse(JSON.parse(readFile(PACKAGE_JSON_PATH)));
    return parsed.success ? parsed.data.version : null;
  } catch {
    return null;
  }
}
