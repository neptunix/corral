import type { SessionRow, Snapshot } from "@shared/schema";

import type { HerdrEnv } from "../environments.ts";
import type { PaneIdentity, SelfResolution } from "./whoami.ts";
import { synthesizeRow } from "./whoami.ts";

// Separate from resolveSelf, which considers local environments only (ADR 0009).
function pick(rows: readonly SessionRow[], env: HerdrEnv, paneId: string, cwd: string): SelfResolution {
  const only = rows[0];
  if (only !== undefined && rows.length === 1) return { ok: true, env, row: only };
  if (only === undefined) {
    return {
      ok: false,
      code: "not_found",
      reason: `no registered Claude agent at pane ${paneId} in environment "${env.id}"`,
    };
  }
  // One herdr server cannot reuse a pane id, so this is a stale row beside its replacement.
  const byCwd = rows.filter((r) => r.cwd === cwd);
  const soleByCwd = byCwd[0];
  if (soleByCwd !== undefined && byCwd.length === 1) return { ok: true, env, row: soleByCwd };
  return {
    ok: false,
    code: "ambiguous",
    reason: `pane ${paneId} matches ${String(rows.length)} sessions in environment "${env.id}"`,
  };
}

// No socket hint on this path: the transport asserts the environment, and the preamble is strict.
export function resolveSelfInEnv(input: {
  readonly snapshot: Snapshot;
  readonly env: HerdrEnv;
  readonly paneId: string;
  readonly cwd: string;
}): SelfResolution {
  const { snapshot, env, paneId, cwd } = input;
  const rows = snapshot.sessions.filter((r) => r.env === env.id && r.paneId === paneId);
  return pick(rows, env, paneId, cwd);
}

// For a pane whose Claude has not registered an agent yet — a freshly spawned session's first call.
export async function resolveSelfInEnvViaPane(input: {
  readonly env: HerdrEnv;
  readonly paneId: string;
  readonly lookup: (env: HerdrEnv, paneId: string) => Promise<PaneIdentity | null>;
}): Promise<SelfResolution> {
  const { env, paneId, lookup } = input;
  const pane = await lookup(env, paneId);
  if (pane === null) {
    return {
      ok: false,
      code: "not_found",
      reason: `no pane ${paneId} in environment "${env.id}" — this session does not appear to be running under corral`,
    };
  }
  return { ok: true, env, row: synthesizeRow(env, pane) };
}
