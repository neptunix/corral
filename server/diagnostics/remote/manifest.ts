import { STANDARD_BIN_DIRS } from "../deps.ts";

export type SubjectKind = "file" | "dir" | "exec" | "value";
export interface ManifestEntry { readonly key: string; readonly kind: SubjectKind; readonly path: string; }
export interface ProbeManifest {
  readonly entries: readonly ManifestEntry[];
  readonly homeKey: string;
  readonly pathKey: string;
}

/**
 * Every statically-known per-config-dir file round F fetches. The guard test requires this list to
 * equal the union of paths the producers actually ask for — add a file to a producer and forget it
 * here, and that test fails; there is no hand-maintained key→subject table to drift (B1's fix).
 */
export const PER_DIR_FILES: readonly string[] = [
  "settings.json",
  "corral-status-capture.sh",
  "corral-claude-hook.sh",
  "skills/corral/SKILL.md",
  "themes/corral.json",
];

export function buildManifest(configDirs: readonly string[]): ProbeManifest {
  const entries: ManifestEntry[] = [];
  let n = 0;
  const push = (kind: SubjectKind, path: string): string => {
    const key = `f_${String(n)}`;
    n += 1;
    entries.push({ key, kind, path });
    return key;
  };
  const homeKey = push("value", "$HOME");
  const pathKey = push("value", "$PATH");
  for (const dir of configDirs) {
    push("dir", dir);
    for (const rel of PER_DIR_FILES) push("file", `${dir}/${rel}`);
  }
  for (const d of STANDARD_BIN_DIRS) push("exec", `${d}/jq`);
  return { entries, homeKey, pathKey };
}
