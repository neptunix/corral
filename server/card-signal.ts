import type { Board } from "@shared/board-schema.ts";
import type { CardSignalResponse, Snapshot } from "@shared/schema";

import type { HerdrEnv } from "../environments.ts";
import { findCard } from "./session-binding.ts";
import { resolveSelf } from "./whoami.ts";

/**
 * Pure: does the caller's pane resolve to a card, and is that card's description blank? Any
 * unresolved pane or missing card answers `false` — the route's job, not this function's, to decide
 * what a malformed board or absent storage means.
 */
export function cardSignal(
  boards: readonly Board[],
  snapshot: Snapshot,
  envs: readonly HerdrEnv[],
  pane: { readonly paneId: string; readonly cwd: string; readonly socket: string | null },
): CardSignalResponse {
  const resolution = resolveSelf({ snapshot, envs, paneId: pane.paneId, cwd: pane.cwd, socket: pane.socket });
  if (!resolution.ok) return { empty: false };
  const found = findCard(boards, resolution.row);
  if (found === undefined) return { empty: false };
  return { empty: found.task.description.trim() === "" };
}
