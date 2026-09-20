import type { SessionRow, Snapshot } from "@shared/schema";

import type { HerdrEnv } from "../environments.ts";
import type { PaneIdentity, SelfResolution } from "./whoami.ts";
import { synthesizeRow } from "./whoami.ts";

/**
 * Identity resolution for a caller whose ENVIRONMENT was asserted by the transport it arrived on,
 * rather than inferred from anything the caller said — today, a session on a remote environment
 * reaching corral through that environment's own reverse-forwarded MCP socket (ADR 0009).
 *
 * This is deliberately a separate function from `resolveSelf`, not a flag on it. `resolveSelf`
 * considers LOCAL environments only, and that is a security property rather than a convenience: it
 * is what stops a caller that can reach the loopback API from naming a remote environment and
 * writing to its cards. Widening it with a "pinned env" parameter would put the two rules in one
 * body, where a future edit could leak one into the other. Here the environment is not a parameter
 * a request carries at all — it is bound when the listener is created.
 *
 * For the same reason there is no socket hint in this file. The shim still sends one (it is the
 * caller's own `HERDR_SOCKET_PATH`), and it is deliberately ignored: within a pinned environment it
 * could only ever narrow a set already narrowed by the transport, and honouring it would mean a
 * remote caller could influence its own resolution by editing an environment variable. Pane id and
 * cwd remain hints, exactly as ADR 0002 decision 4 has them — one level down, inside an environment
 * that is now fixed.
 */
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
  // Two panes of one herdr server cannot share an id, so this is a stale snapshot holding both a
  // dead row and its replacement rather than a genuine collision. cwd breaks the tie when it can;
  // when it cannot, answering "ambiguous" is the safe half of fail-unresolved-never-resolve-wrong.
  const byCwd = rows.filter((r) => r.cwd === cwd);
  const soleByCwd = byCwd[0];
  if (soleByCwd !== undefined && byCwd.length === 1) return { ok: true, env, row: soleByCwd };
  return {
    ok: false,
    code: "ambiguous",
    reason: `pane ${paneId} matches ${String(rows.length)} sessions in environment "${env.id}"`,
  };
}

/** Resolve the caller against the poller snapshot, within one already-asserted environment. */
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

/**
 * The pane-level fallback, for a pane whose Claude has not registered an agent yet — the moment a
 * freshly spawned session calls `corral_whoami`, which its brief tells it to do first. Same role as
 * `resolveSelfViaPane`, over one environment instead of a socket-gated pool.
 */
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
