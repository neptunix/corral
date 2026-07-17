import type { EnvState } from "@shared/schema";

// Map an env id (e.g. "gl-local") to its operator-facing label (e.g. "Personal (local)") from the
// snapshot's env record — the display name comes from the trusted env config. Falls back to the raw
// id when the label hasn't arrived (legacy payload, or the env is absent from the current snapshot);
// the id is always a safe last resort. Routing/keys stay on the id — this is display-only.
export function envLabel(envs: Readonly<Record<string, EnvState>>, id: string): string {
  return envs[id]?.label ?? id;
}
