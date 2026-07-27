import type { SessionRow, Snapshot } from "@shared/schema";

import type { HerdrEnv } from "../environments.ts";
import { expandTilde } from "./herdr.ts";

type LocalEnv = Extract<HerdrEnv, { kind: "local" }>;

export type SelfResolution =
  | { readonly ok: true; readonly env: HerdrEnv; readonly row: SessionRow }
  | { readonly ok: false; readonly reason: string };

interface Candidate {
  readonly env: LocalEnv;
  readonly row: SessionRow;
}

// Type predicate, not an assertion: `filter` alone would not narrow the union, and `as` is banned.
function isLocal(env: HerdrEnv): env is LocalEnv {
  return env.kind === "local";
}

function sole(candidates: readonly Candidate[]): Candidate | undefined {
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Which session is the caller? Only the MCP client's own coordinates are trusted as *hints*: the
 * authoritative data is the poller snapshot plus the trusted env config.
 *
 * A paneId is unique within one herdr session but can repeat across environments, so ties are broken
 * by an exact socket match first, then by cwd. cwd is only a tie-breaker: the row's cwd is the pane's,
 * which can legitimately diverge from the Claude process's working directory, so a hard equality gate
 * would produce false negatives. Remote environments are excluded — the MCP process runs on the same
 * host as corral in phase 1.
 */
export function resolveSelf(input: {
  readonly snapshot: Snapshot;
  readonly envs: readonly HerdrEnv[];
  readonly paneId: string;
  readonly cwd: string;
  readonly socket: string | null;
}): SelfResolution {
  const { snapshot, envs, paneId, cwd, socket } = input;

  const candidates: Candidate[] = [];
  for (const env of envs.filter(isLocal)) {
    for (const row of snapshot.sessions) {
      if (row.env === env.id && row.paneId === paneId) candidates.push({ env, row });
    }
  }

  const only = sole(candidates);
  if (only !== undefined) return { ok: true, env: only.env, row: only.row };
  if (candidates.length === 0) {
    return { ok: false, reason: `no live session at pane ${paneId} in any local environment` };
  }

  if (socket !== null) {
    const want = expandTilde(socket);
    const bySocket = sole(
      candidates.filter((c) => c.env.socket !== undefined && expandTilde(c.env.socket) === want),
    );
    if (bySocket !== undefined) return { ok: true, env: bySocket.env, row: bySocket.row };
  }

  const byCwd = sole(candidates.filter((c) => c.row.cwd === cwd));
  if (byCwd !== undefined) return { ok: true, env: byCwd.env, row: byCwd.row };

  const ids = candidates.map((c) => c.env.id).join(", ");
  return { ok: false, reason: `pane ${paneId} is ambiguous across environments: ${ids}` };
}
