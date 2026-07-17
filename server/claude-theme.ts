import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

// Only light/dark are meaningful `base` presets we flip between from the web toggle.
export const ThemeModeSchema = z.enum(["light", "dark"]);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

// The single custom-theme file we manage. Claude Code hot-reloads `~/.claude/themes/*.json`, so
// flipping this file's `base` live-switches the TUI of any session that selected `custom:corral`.
const THEME_FILE = "corral.json";

// Flip ONLY the `base` field of an existing `themes/corral.json` inside each trusted Claude config dir.
// Security posture (this is a write endpoint on a no-auth localhost server):
//   - `dirs` come from startup config (environments.ts `claudeConfigDirs`), never from the request —
//     the request supplies only the light|dark mode, so there is no attacker-controlled path.
//   - Fixed filename, fixed field; other fields (name, overrides) are preserved verbatim.
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // corrupt JSON — do not overwrite the user's file
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const next: Record<string, unknown> = { ...parsed };
    next.base = mode;
    await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    updated++;
  }
  return updated;
}
