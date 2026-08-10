import type { SpawnRequestBody } from "./api";

/**
 * The spawn request body, built from the panel's form state.
 *
 * Pure and tested here because two rules carry real logic — asserting them directly on plain input is
 * more direct than driving SpawnPanel's rendered form through several layers of DOM interaction to
 * hit the same two branches:
 *
 * 1. Optional keys are OMITTED at their defaults, never sent as null/false — the route reads absence
 *    as "off" (remoteControl) and "inherit" (model), so sending a falsy value is a different request.
 * 2. The start command is omitted whenever the resolved env kind is NOT "local" — a property of the
 *    REQUEST, not of a control's `disabled` attribute, so a stale control can never leak one to a
 *    remote env. The selection itself is preserved, so switching back restores the pick.
 *    Unknown kind counts as not-local, mirroring the file-drop gate in App.tsx.
 */
export interface SpawnFormState {
  readonly env: string;
  readonly envKind: "local" | "remote" | null;
  readonly targetWorkspaceId: string | null;
  readonly repo: string | null;
  readonly model: string | null;
  readonly remoteControl: boolean;
  readonly startCommand: string | null;
}

export function buildSpawnRequest(state: SpawnFormState): SpawnRequestBody {
  const command = state.envKind === "local" ? state.startCommand : null;
  return {
    env: state.env,
    targetWorkspaceId: state.targetWorkspaceId,
    repo: state.repo,
    ...(state.model === null ? {} : { model: state.model }),
    ...(state.remoteControl ? { remoteControl: true } : {}),
    ...(command === null || command === "" ? {} : { startCommand: command }),
  };
}
