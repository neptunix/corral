import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { HerdrEnv } from "../environments.ts";
import type { SpawnSsh } from "./remote-write.ts";
import { runRemoteScript } from "./remote-write.ts";

export const ThemeModeSchema = z.enum(["light", "dark"]);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

// Claude Code hot-reloads this file, so rewriting `base` live-switches running sessions.
const THEME_FILE = "corral.json";

// Null means leave the file alone; an already-matching file must not be rewritten (the write triggers the hot-reload).
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

// dirs come from startup config only; the request supplies just the mode, so no path is attacker-controlled.
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

const REMOTE_THEME_TIMEOUT_MS = 10_000;

// Prints nothing and exits 0 when the file is missing, so "no theme here" is not mistaken for a failed ssh.
const READ_THEME_SCRIPT = 'if [ -f "$1" ]; then cat "$1"; fi';
// Renames a sibling temp file over the resolved target, so the hot-reload never sees a partial write and a symlink survives.
const WRITE_THEME_SCRIPT =
  'f=$(readlink -f -- "$1" 2>/dev/null) || f=""; [ -n "$f" ] || f="$1"; umask 077; t="$f.corral-tmp.$$"; ' +
  'if cat > "$t"; then mv -f "$t" "$f"; else rm -f "$t"; exit 1; fi';

// Read and write are separate ssh calls; without queuing, overlapping toggles can leave the older mode on disk.
const remoteSyncTail = new Map<string, Promise<unknown>>();
function serializedPerEnv<T>(envId: string, run: () => Promise<T>): Promise<T> {
  const prev = remoteSyncTail.get(envId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(run);
  remoteSyncTail.set(envId, next);
  return next;
}

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
      const next = flippedTheme(raw, mode); // an empty read (no theme in this dir) parses as null
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
