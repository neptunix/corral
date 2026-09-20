import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { HerdrEnv } from "../environments.ts";
import type { SpawnSsh } from "./remote-write.ts";
import { runRemoteScript } from "./remote-write.ts";

// Only light/dark are meaningful `base` presets we flip between from the web toggle.
export const ThemeModeSchema = z.enum(["light", "dark"]);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

// The single custom-theme file we manage. Claude Code hot-reloads `~/.claude/themes/*.json`, so
// flipping this file's `base` live-switches the TUI of any session that selected `custom:corral`.
const THEME_FILE = "corral.json";

// The next text of a theme file with its `base` set to `mode`, or null when the file must be left
// alone: corrupt JSON (never overwrite the user's file), not an object, or already in sync (the write
// itself is what triggers Claude Code's hot-reload, so a no-op sync must not touch a running TUI).
// Every other field (name, overrides) is preserved verbatim.
function flippedTheme(raw: string, mode: ThemeMode): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const next: Record<string, unknown> = { ...parsed };
  if (next.base === mode) return null;
  next.base = mode;
  return `${JSON.stringify(next, null, 2)}\n`;
}

// Flip ONLY the `base` field of an existing `themes/corral.json` inside each trusted Claude config dir.
// Security posture (this is a write endpoint on a no-auth localhost server):
//   - `dirs` come from startup config (environments.ts `claudeConfigDirs`), never from the request —
//     the request supplies only the light|dark mode, so there is no attacker-controlled path.
//   - Fixed filename, fixed field.
//   - Never creates files: a dir without a corral theme is skipped, not populated.
//   - Missing/corrupt files are skipped, not fatal — theme sync is best-effort cosmetics, so a bad
//     file must never crash the request or clobber a user's edited theme.
// Returns the number of files actually updated.
export async function syncClaudeThemeBase(dirs: readonly string[], mode: ThemeMode): Promise<number> {
  let updated = 0;
  for (const dir of dirs) {
    const file = path.join(dir, "themes", THEME_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue; // no corral theme in this dir — leave it alone
    }
    const next = flippedTheme(raw, mode);
    if (next === null) continue;
    await fs.writeFile(file, next, "utf8");
    updated++;
  }
  return updated;
}

// One overall bound per ssh call: the theme file is a few KB, so this only fires on a stalled link.
const REMOTE_THEME_TIMEOUT_MS = 10_000;

// `[ -f ]` first, so a dir with no corral theme prints nothing and exits 0 ("skip") instead of being
// indistinguishable from a failed ssh. $1 is the fixed-name file inside a configured config dir.
const READ_THEME_SCRIPT = 'if [ -f "$1" ]; then cat "$1"; fi';
// Write to a sibling temp file and rename, so Claude Code's hot-reload never reads a half-written theme.
// A symlinked corral.json is resolved first and the TARGET replaced, matching the local sync (a plain
// writeFile follows the link); renaming over the link itself would silently turn it into a regular file.
const WRITE_THEME_SCRIPT =
  'f=$(readlink -f -- "$1" 2>/dev/null) || f=""; [ -n "$f" ] || f="$1"; umask 077; t="$f.corral-tmp.$$"; ' +
  'if cat > "$t"; then mv -f "$t" "$f"; else rm -f "$t"; exit 1; fi';

// One sync at a time per remote env. The read, the "already in sync" decision and the write are separate
// ssh calls, so two overlapping toggles could otherwise interleave: the later request reads the stale
// value, skips its write as a no-op, and the earlier request's write lands last. Queued in arrival order,
// every sync reads what the previous one wrote, so the last request always wins.
const remoteSyncTail = new Map<string, Promise<unknown>>();
function serializedPerEnv<T>(envId: string, run: () => Promise<T>): Promise<T> {
  const prev = remoteSyncTail.get(envId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(run);
  remoteSyncTail.set(envId, next);
  return next;
}

/**
 * The remote counterpart of `syncClaudeThemeBase`, for one remote environment: same rules (config-dir
 * list from startup config, fixed file, never creates a file, corrupt/missing skipped), with the file
 * read and rewritten over the shared ssh connection. The edit itself happens here, not on the remote,
 * so it needs nothing installed there. Remote `claudeConfigDirs` are absolute (`~` is rejected at
 * config load), so the paths are used as given. One dir failing does not stop the others; the first
 * error is thrown after every dir was tried.
 */
export function syncRemoteClaudeThemeBase(
  env: Extract<HerdrEnv, { readonly kind: "remote" }>,
  mode: ThemeMode,
  spawnFn?: SpawnSsh,
): Promise<number> {
  return serializedPerEnv(env.id, () => syncRemoteDirs(env, mode, spawnFn));
}

async function syncRemoteDirs(
  env: Extract<HerdrEnv, { readonly kind: "remote" }>,
  mode: ThemeMode,
  spawnFn: SpawnSsh | undefined,
): Promise<number> {
  let updated = 0;
  let firstError: Error | null = null;
  for (const dir of env.claudeConfigDirs) {
    const file = `${dir}/themes/${THEME_FILE}`;
    const base = { args: [file], timeoutMs: REMOTE_THEME_TIMEOUT_MS, ...(spawnFn === undefined ? {} : { spawnFn }) };
    try {
      const raw = await runRemoteScript(env, { ...base, script: READ_THEME_SCRIPT, stdin: new Uint8Array(), what: "remote theme read" });
      const next = flippedTheme(raw, mode); // an empty read (no theme in this dir) is not JSON: null
      if (next === null) continue;
      await runRemoteScript(env, { ...base, script: WRITE_THEME_SCRIPT, stdin: new TextEncoder().encode(next), what: "remote theme write" });
      updated++;
    } catch (err) {
      firstError ??= err instanceof Error ? err : new Error(String(err));
    }
  }
  if (firstError !== null) throw firstError;
  return updated;
}
