import type { Board, SessionLink, Task } from "@shared/board-schema.ts";
import type { SessionRow, Snapshot } from "@shared/schema";
import type { WhoamiCardSession, WhoamiEnv, WhoamiResponse, WhoamiSession, WhoamiTask } from "@shared/whoami-schema.ts";

import type { HerdrEnv } from "../environments.ts";
import { expandTilde } from "./herdr.ts";
import { buildLiveIndex, type LiveIndex, resolveLiveRow } from "./live-resolve.ts";
import { linkBindsSession } from "./session-binding.ts";

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

function envList(envs: readonly HerdrEnv[], snapshot: Snapshot): WhoamiEnv[] {
  return envs.map((e) => ({
    id: e.id,
    label: e.label,
    kind: e.kind,
    // An env absent from the snapshot has not been polled successfully yet → treat as unreachable.
    reachable: snapshot.envs[e.id]?.reachable ?? false,
  }));
}

function cardSession(index: LiveIndex, link: SessionLink, selfRow: SessionRow): WhoamiCardSession {
  // Liveness via the CANONICAL resolver (server/live-resolve.ts), not a local reimplementation: a
  // UUID-carrying link whose pane now holds a different session resolves via the UUID index or
  // reports detached — never the stranger. Board UI and whoami must agree on this.
  const live = resolveLiveRow(link, index);
  return {
    name: link.name,
    key: `${link.env}:${link.paneId}`,
    sessionId: link.sessionId,
    status: live?.status ?? "detached",
    detached: live === undefined,
    ctxPct: live?.statusline?.ctx.pct ?? null,
    self: linkBindsSession(link, { env: selfRow.env, paneId: selfRow.paneId, liveSessionId: selfRow.sessionId }),
  };
}

function findCard(
  boards: readonly Board[],
  row: SessionRow,
): { readonly board: Board; readonly task: Task } | undefined {
  const incoming = { env: row.env, paneId: row.paneId, liveSessionId: row.sessionId };
  for (const board of boards) {
    for (const task of board.tasks) {
      if (task.sessions.some((l) => linkBindsSession(l, incoming))) {
        return { board, task };
      }
    }
  }
  return undefined;
}

function taskBlock(boards: readonly Board[], snapshot: Snapshot, row: SessionRow): WhoamiTask | null {
  const found = findCard(boards, row);
  if (found === undefined) return null;
  const index = buildLiveIndex(snapshot.sessions);
  return {
    boardId: found.board.id,
    boardLabel: found.board.label,
    taskId: found.task.id,
    title: found.task.title,
    description: found.task.description,
    status: found.task.status,
    priority: found.task.priority,
    columns: found.board.columns.map((c) => ({ id: c.id, label: c.label })),
    sessions: found.task.sessions.map((l) => cardSession(index, l, row)),
  };
}

function sessionBlock(env: HerdrEnv, row: SessionRow): WhoamiSession {
  const sl = row.statusline;
  return {
    env: env.id,
    envLabel: env.label,
    paneId: row.paneId,
    tabId: row.tabId ?? "",
    tabLabel: row.tab,
    workspaceId: row.workspaceId ?? "",
    workspaceLabel: row.workspace,
    sessionId: row.sessionId,
    sessionName: sl?.session_name ?? null,
    cwd: row.cwd,
    status: row.status,
    model: sl?.model ?? null,
    ctxPct: sl?.ctx.pct ?? null,
    costUsd: sl?.cost.usd ?? null,
    fiveHourPct: sl?.rate.five_hour?.used_percentage ?? null,
    sevenDayPct: sl?.rate.seven_day?.used_percentage ?? null,
    account: sl?.account?.email ?? sl?.account?.org ?? null,
  };
}

/** Compose the whoami payload. Pure: takes already-read boards rather than the storage handle. */
export function buildWhoami(input: {
  readonly resolution: SelfResolution;
  readonly envs: readonly HerdrEnv[];
  readonly snapshot: Snapshot;
  readonly boards: readonly Board[];
}): WhoamiResponse {
  const { resolution, envs, snapshot, boards } = input;
  const list = envList(envs, snapshot);
  if (!resolution.ok) return { resolved: false, reason: resolution.reason, envs: list };
  return {
    resolved: true,
    session: sessionBlock(resolution.env, resolution.row),
    task: taskBlock(boards, snapshot, resolution.row),
    envs: list,
  };
}
