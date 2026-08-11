import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { UUID_RE } from "./herdr.ts";

export const FLEET_MIRROR_FILENAME = "fleet-mirror.json";

// `sessionId` is schema-pinned to the uuid shape: this value later reaches an unquoted shell
// interpolation (`--resume ${id}` via `pane run`) and an SSH command (`sessionCwd`), so the pin is a
// load-bearing safety control, mirroring the per-link resume route's explicit UUID_RE gate.
// Fail secure: a record failing the regex never spawns.
const MirrorSessionSchema = z.object({
  sessionId: z.string().regex(UUID_RE),
  name: z.string(),
  cwd: z.string(),
  workspaceLabel: z.string(),
});

const MirrorEnvSchema = z.object({
  // last STRUCTURAL write, not last poll — compare-before-write skips no-op ticks
  updatedAt: z.number(),
  pendingRestore: z.boolean(),
  sessions: z.array(MirrorSessionSchema),
});

export const FleetMirrorFileSchema = z.object({
  version: z.literal(1),
  envs: z.record(z.string(), MirrorEnvSchema),
});

export type MirrorSession = z.infer<typeof MirrorSessionSchema>;
export type MirrorEnv = z.infer<typeof MirrorEnvSchema>;
export type FleetMirrorFile = z.infer<typeof FleetMirrorFileSchema>;

export function mirrorPath(dataDir: string): string {
  return path.join(dataDir, FLEET_MIRROR_FILENAME);
}

/** null = file absent (nothing ever recorded). Unreadable/invalid THROWS with the path in the
 *  message — restore must answer 500 naming the file, never guess. */
export function readMirrorFile(filePath: string): FleetMirrorFile | null {
  if (!existsSync(filePath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`fleet mirror ${filePath} is unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = FleetMirrorFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`fleet mirror ${filePath} failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}
