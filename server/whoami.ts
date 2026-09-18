import type { Board, SessionLink } from "@shared/board-schema.ts";
import type { SessionRow, Snapshot } from "@shared/schema";
import type { WhoamiCardSession, WhoamiEnv, WhoamiResponse, WhoamiSession, WhoamiSpawnedBy, WhoamiTask } from "@shared/whoami-schema.ts";

import type { HerdrEnv } from "../environments.ts";
import { expandTilde } from "./herdr.ts";
import { displacingName } from "./link-name.ts";
import { buildLiveIndex, type LiveIndex, resolveLiveRow } from "./live-resolve.ts";
import { findCard, linkBindsSession } from "./session-binding.ts";

type LocalEnv = Extract<HerdrEnv, { kind: "local" }>;

export type SelfResolution =
  | { readonly ok: true; readonly env: HerdrEnv; readonly row: SessionRow }
  // `code` separates "corral has never heard of this pane" from "it matched more than one
  // environment". Only the former is worth escalating to a pane-level lookup; escalating an
  // ambiguous match would throw away a real row (with its metrics) in favour of a synthesized one.
  | { readonly ok: false; readonly code: "not_found" | "ambiguous"; readonly reason: string };

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
 * A local env with no configured `socket` runs on whatever `HERDR_SOCKET_PATH` corral itself was
 * launched under (see README "Launching corral" / environments.ts) — a pane in that env forwards that
 * same ambient value as its own hint. `ambientSocket` carries that value in so this stays a pure,
 * testable function instead of reading `process.env` here.
 */
function effectiveSocket(env: LocalEnv, ambientSocket: string | null): string | null {
  if (env.socket !== undefined) return expandTilde(env.socket);
  return ambientSocket === null ? null : expandTilde(ambientSocket);
}

/**
 * Ties among same-pane-id candidates: an exact socket match first, then cwd. cwd is only a
 * tie-breaker — the row's cwd is the pane's, which can legitimately diverge from the Claude process's
 * working directory, so a hard equality gate would produce false negatives.
 */
function pickAmong(candidates: readonly Candidate[], cwd: string, paneId: string): SelfResolution {
  const only = sole(candidates);
  if (only !== undefined) return { ok: true, env: only.env, row: only.row };
  const byCwd = sole(candidates.filter((c) => c.row.cwd === cwd));
  if (byCwd !== undefined) return { ok: true, env: byCwd.env, row: byCwd.row };
  const ids = candidates.map((c) => c.env.id).join(", ");
  return { ok: false, code: "ambiguous", reason: `pane ${paneId} is ambiguous across environments: ${ids}` };
}

/**
 * Which session is the caller? Only the MCP client's own coordinates are trusted as *hints*: the
 * authoritative data is the poller snapshot plus the trusted env config.
 *
 * A paneId is unique within one herdr session but can repeat across environments — and across other
 * herdr servers entirely, including remote environments' panes, which this function never sees as
 * candidates but whose pane ids can still collide with a local one. So a socket hint, when present,
 * is a GATE, not just a tie-breaker: a candidate whose environment's effective socket (its configured
 * `socket`, or the ambient default for one that omits it) does not match the hint is refused outright,
 * even if it is the only local candidate for that pane id. A null/absent hint keeps the pre-hint
 * behaviour of matching on pane id alone. See ADR 0002 decision 4 — this tightens "socket disambiguates,
 * never routes" into "socket must at least agree", it does not let the socket pick an env by itself.
 */
export function resolveSelf(input: {
  readonly snapshot: Snapshot;
  readonly envs: readonly HerdrEnv[];
  readonly paneId: string;
  readonly cwd: string;
  readonly socket: string | null;
  readonly ambientSocket: string | null;
}): SelfResolution {
  const { snapshot, envs, paneId, cwd, socket, ambientSocket } = input;

  const candidates: Candidate[] = [];
  for (const env of envs.filter(isLocal)) {
    for (const row of snapshot.sessions) {
      if (row.env === env.id && row.paneId === paneId) candidates.push({ env, row });
    }
  }

  if (candidates.length === 0) {
    // Not terminal: the route escalates a not_found to a pane-level lookup, which sees panes this
    // snapshot cannot (it is built from `herdr agent list`, so it holds only panes with a registered
    // agent). This reason is what a direct caller of resolveSelf sees.
    return {
      ok: false,
      code: "not_found",
      reason: `no registered Claude agent at pane ${paneId} in any local environment`,
    };
  }

  if (socket === null) return pickAmong(candidates, cwd, paneId);

  const want = expandTilde(socket);
  const matching = candidates.filter((c) => effectiveSocket(c.env, ambientSocket) === want);
  if (matching.length === 0) {
    // Reuses the "not_found" code so the route's not_found escalation to resolveSelfViaPane is safe:
    // that function applies the identical socket gate and refuses to even look, rather than resolving
    // a fresh pane the same wrong way.
    return {
      ok: false,
      code: "not_found",
      reason: `pane ${paneId} matches a local environment by pane id, but socket "${socket}" does not match any local environment's socket`,
    };
  }
  return pickAmong(matching, cwd, paneId);
}

export interface PaneIdentity {
  readonly paneId: string;
  readonly tabId: string;
  readonly tabLabel: string;
  readonly workspaceId: string;
  readonly workspaceLabel: string;
  readonly cwd: string;
}

/** Status reported for a pane that exists but has no Claude agent registered on it yet. */
export const STARTING_STATUS = "starting";

/**
 * Fallback identity for a pane that herdr has not registered an agent on yet.
 *
 * `resolveSelf` above can only match panes present in the poller snapshot, which is built from
 * `herdr agent list` — so it is blind to a pane whose Claude is still booting. That is precisely the
 * moment a spawned session calls corral_whoami, because its brief tells it to do that first. Rather
 * than tell a live session it does not exist, ask herdr about the PANE directly and synthesize the
 * row from it.
 *
 * The synthesized row carries `sessionId: null` and no statusline, which the payload schema already
 * models (`formatWhoami` renders "session id: not registered yet") — so metrics simply appear on a
 * later call. Everything that does not depend on the agent works immediately, including the CARD:
 * `linkBindsSession` matches a session-less link on env + paneId, so a spawned session finds the card
 * it was spawned onto without waiting for herdr at all.
 *
 * When a socket hint is present it GATES the environments tried, the same rule `resolveSelf` applies:
 * a pane id can collide with one from another herdr server entirely (a remote env's pane, say), and
 * that pane hasn't even reached this snapshot yet — the fresh-pane case this function exists for — so
 * the socket is the only signal available. An env whose effective socket does not match is never even
 * asked about the pane. A null hint keeps the pre-hint behaviour of trying every local env.
 */
export async function resolveSelfViaPane(input: {
  readonly envs: readonly HerdrEnv[];
  readonly paneId: string;
  readonly socket: string | null;
  readonly ambientSocket: string | null;
  readonly lookup: (env: HerdrEnv, paneId: string) => Promise<PaneIdentity | null>;
}): Promise<SelfResolution> {
  const { envs, paneId, socket, ambientSocket, lookup } = input;
  const locals = envs.filter(isLocal);

  let pool: readonly LocalEnv[];
  if (socket === null) {
    pool = locals;
  } else {
    const want = expandTilde(socket);
    pool = locals.filter((e) => effectiveSocket(e, ambientSocket) === want);
    if (pool.length === 0) {
      return {
        ok: false,
        code: "not_found",
        reason: `pane ${paneId} was not found locally, and socket "${socket}" does not match any local environment's socket`,
      };
    }
  }

  for (const env of pool) {
    const pane = await lookup(env, paneId);
    if (pane === null) continue;
    return {
      ok: true,
      env,
      row: {
        env: env.id,
        paneId: pane.paneId,
        status: STARTING_STATUS,
        agent: "claude",
        cwd: pane.cwd,
        tab: pane.tabLabel,
        workspace: pane.workspaceLabel,
        tabId: pane.tabId,
        workspaceId: pane.workspaceId,
        sessionId: null,
        recap: null,
        recapAt: null,
        recapStatus: null,
        recapSource: null,
        statusline: null,
        statuslineStatus: null,
        claudeStatus: null,
        waitingFor: null,
        remoteControl: null,
        registryStatus: null,
        // Synthesized from a pane lookup, with no registry read behind it.
        claudeName: null,
        claudeNameUserSet: null,
      },
    };
  }
  return {
    ok: false,
    code: "not_found",
    reason: `no pane ${paneId} in any local environment — this session does not appear to be running under corral`,
  };
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

/**
 * The session's name as Claude's registry has it, for a value that will be STORED rather than shown.
 * Gated on `claudeNameUserSet` — the same gate the tab renamer (server/tab-namer.ts), the board's
 * enriched `name` (server/api.ts) and the fleet mirror use — because `sessionName` feeds the MCP
 * attach (mcp/tools/task.ts), which writes it into `SessionLink.name`, the DURABLE projection. An
 * auto-derived name landing there is permanent: the reconciler mirrors user-set names only
 * (server/reconcile.ts).
 *
 * Returns null rather than falling back to the tab label — the consumer supplies its own fallback.
 *
 * NORMALIZED, like every other gated writer of this name (server/api.ts, server/fleet-mirror.ts,
 * server/reconcile.ts): this string is stored, and an un-normalized registry name would carry control
 * sequences and an unbounded length into the board file. `claudeNameOf` collapses "" to null, but the
 * normalizer can produce "" from a whitespace-only name, so the result is re-tested.
 */
function storedName(row: SessionRow): string | null {
  const clean = displacingName(row);
  return clean === "" ? null : clean;
}

/** Same email-or-org projection every live-account display uses (sessionBlock, cardSession, the
 *  fleet row in mcp/digest.ts) — one place so the rule never drifts between them. */
function accountOf(row: SessionRow): string | null {
  return row.statusline?.account?.email ?? row.statusline?.account?.org ?? null;
}

function cardSession(index: LiveIndex, link: SessionLink, selfRow: SessionRow): WhoamiCardSession {
  // Liveness via the CANONICAL resolver (server/live-resolve.ts), not a local reimplementation: a
  // UUID-carrying link whose pane now holds a different session resolves via the UUID index or
  // reports detached — never the stranger. Board UI and whoami must agree on this.
  const live = resolveLiveRow(link, index);
  return {
    name: link.name,
    claudeName: live?.claudeName ?? null,
    key: `${link.env}:${link.paneId}`,
    sessionId: link.sessionId,
    status: live?.status ?? "detached",
    detached: live === undefined,
    ctxPct: live?.statusline?.ctx.pct ?? null,
    self: linkBindsSession(link, { env: selfRow.env, paneId: selfRow.paneId, liveSessionId: selfRow.sessionId }),
    account: live === undefined ? null : accountOf(live),
  };
}

/** The link the SELF row binds to — the same rule cardSession uses for its `self` flag. Several
 *  links can bind (env+pane collision across boards); a sessionId match is preferred over a
 *  pane-only one, since the pane can be a stale reuse. */
function selectSelfLink(links: readonly SessionLink[], row: SessionRow): SessionLink | undefined {
  const matches = links.filter((l) => linkBindsSession(l, { env: row.env, paneId: row.paneId, liveSessionId: row.sessionId }));
  return matches.find((l) => l.sessionId !== null && l.sessionId === row.sessionId) ?? matches[0];
}

/** The name a link with this env+sessionId is stored under, searched across every board — the
 *  parent may live on a different card than the one this session is on. */
function storedLinkName(boards: readonly Board[], env: string, sessionId: string): string | null {
  for (const b of boards) {
    for (const t of b.tasks) {
      for (const s of t.sessions) {
        if (s.env === env && s.sessionId === sessionId) return s.name;
      }
    }
  }
  return null;
}

function resolveSpawnedBy(spawnedBy: SessionLink["spawnedBy"], index: LiveIndex, boards: readonly Board[]): WhoamiSpawnedBy {
  if (spawnedBy === undefined) return null;
  if (spawnedBy === "operator") return "operator";
  const row = resolveLiveRow({ env: spawnedBy.env, paneId: spawnedBy.paneId, sessionId: spawnedBy.sessionId }, index);
  if (row !== undefined) {
    return {
      name: row.claudeName ?? storedLinkName(boards, spawnedBy.env, spawnedBy.sessionId),
      running: true,
      captured: row.claudeName !== null,
      account: accountOf(row),
    };
  }
  // Closed: no live row, so no account to report — the name (if any) comes from what was last stored.
  return { name: storedLinkName(boards, spawnedBy.env, spawnedBy.sessionId), running: false, captured: true, account: null };
}

function taskBlock(boards: readonly Board[], snapshot: Snapshot, row: SessionRow): WhoamiTask | null {
  const found = findCard(boards, row);
  if (found === undefined) return null;
  const index = buildLiveIndex(snapshot.sessions);
  const selfLink = selectSelfLink(found.task.sessions, row);
  return {
    boardId: found.board.id,
    boardLabel: found.board.label,
    taskId: found.task.id,
    title: found.task.title,
    description: found.task.description,
    status: found.task.status,
    priority: found.task.priority,
    columns: found.board.columns.map((c) => ({ id: c.id, label: c.label, closed: c.type === "closed" })),
    sessions: found.task.sessions.map((l) => cardSession(index, l, row)),
    logCount: found.task.log.length,
    lastLogAtMs: found.task.log.at(-1)?.atMs ?? null,
    spawnedBy: resolveSpawnedBy(selfLink?.spawnedBy, index, boards),
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
    sessionName: storedName(row),
    claudeName: row.claudeName,
    cwd: row.cwd,
    status: row.status,
    model: sl?.model ?? null,
    ctxPct: sl?.ctx.pct ?? null,
    costUsd: sl?.cost.usd ?? null,
    fiveHourPct: sl?.rate.five_hour?.used_percentage ?? null,
    sevenDayPct: sl?.rate.seven_day?.used_percentage ?? null,
    account: accountOf(row),
    remoteControl: row.remoteControl,
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
