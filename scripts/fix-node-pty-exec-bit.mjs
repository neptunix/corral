// Restore the execute bit on node-pty's prebuilt `spawn-helper` (macOS only).
//
// node-pty@1.1.0 ships the darwin prebuilds with mode 0644 inside the published tarball, so a
// fresh `npm install` extracts a non-executable spawn-helper. Every pty spawn then dies with
// `posix_spawnp failed`, breaking the live terminal out of the box. See:
//   https://github.com/neptunix/corral/issues/4
//
// This runs as a `postinstall` step. It is a no-op where the file is missing — Linux builds
// node-pty from source (compiler sets the bit) and Windows has no spawn-helper at all.
//
// Remove once node-pty ships a stable release >= 1.2.0 (the fix currently only exists in the
// 1.2.0-beta prereleases).

import { chmodSync, existsSync, statSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const EXEC_BITS = 0o111; // u+x, g+x, o+x

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const helpers = ["darwin-arm64", "darwin-x64"].map((platform) =>
  fileURLToPath(
    new URL(`../node_modules/node-pty/prebuilds/${platform}/spawn-helper`, import.meta.url),
  ),
);

for (const helper of helpers) {
  if (!existsSync(helper)) continue;

  const { mode } = statSync(helper);
  if ((mode & EXEC_BITS) === EXEC_BITS) continue; // already executable — nothing to do

  try {
    chmodSync(helper, mode | EXEC_BITS);
    console.log(`[fix-node-pty-exec-bit] restored exec bit on ${relative(repoRoot, helper)}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[fix-node-pty-exec-bit] could not chmod ${relative(repoRoot, helper)}: ${reason}\n` +
        `  The live terminal will fail with "posix_spawnp failed" until you run:\n` +
        `    chmod +x ${helper}`,
    );
  }
}
