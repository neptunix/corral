import type { SpawnRequestBody } from "./api";

/**
 * The spawn request body, built from the panel's form state.
 *
 * Optional keys are OMITTED at their defaults, never sent as null/false — the route reads absence
 * as "off" (remoteControl) and "inherit" (model), so sending a falsy value is a different request.
 */
export interface SpawnFormState {
  readonly env: string;
  readonly targetWorkspaceId: string | null;
  readonly repo: string | null;
  readonly model: string | null;
  readonly remoteControl: boolean;
  readonly startCommand: string | null;
}

export function buildSpawnRequest(state: SpawnFormState): SpawnRequestBody {
  return {
    env: state.env,
    targetWorkspaceId: state.targetWorkspaceId,
    repo: state.repo,
    ...(state.model === null ? {} : { model: state.model }),
    ...(state.remoteControl ? { remoteControl: true } : {}),
    ...(state.startCommand === null || state.startCommand === "" ? {} : { startCommand: state.startCommand }),
    spawnedBy: "operator",
  };
}
