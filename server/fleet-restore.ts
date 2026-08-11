import type { FleetRestoreEnvReport, FleetRestoreReport, FleetRestoreSession, SessionRow } from "@shared/schema";

import type { HerdrEnv } from "../environments.ts";
import { readMirrorFile, type FleetMirrorFile, type MirrorEnv, type MirrorSession } from "./fleet-mirror.ts";
import { listSessions, UUID_RE } from "./herdr.ts";
import { NAME_MAX, sanitizeSlug, slugify, type SpawnOpts, type SpawnResult } from "./spawn.ts";
import { readSessionCwd } from "./transcript.ts";

/**
 * A just-resumed session registers its uuid with herdr only a poll or two later, so an immediate
 * re-run after a partial failure (which exit code 1 actively invites) would double-resume the tail —
 * two panes on one transcript. This window guards back-to-back runs; the in-flight flag guards
 * concurrent ones.
 */
export const RECENT_RESUME_WINDOW_MS = 120_000;

export interface FleetRestoreRequest {
  readonly env?: string | undefined;
  readonly dryRun?: boolean | undefined;
}

export type FleetRestoreRun =
  | { readonly status: "ok"; readonly report: FleetRestoreReport }
  | { readonly status: "no_mirror" }
  | { readonly status: "mirror_unreadable"; readonly message: string }
  | { readonly status: "unknown_env"; readonly env: string }
  | { readonly status: "in_flight" };

export interface FleetRestore {
  run(req: FleetRestoreRequest): Promise<FleetRestoreRun>;
}

// herdr substitutes "?" for an unlabelled workspace; grouping unrelated sessions under a literal "?"
// workspace would be wrong — such records each get their own workspace (repo: null).
function groupable(workspaceLabel: string): boolean {
  return workspaceLabel !== "" && workspaceLabel !== "?";
}

/** Same-label records made adjacent (first-seen order) so the first creates the workspace and the
 *  siblings join it by label; placeholder-labelled records stay solo. */
function orderByWorkspace(records: readonly MirrorSession[]): MirrorSession[] {
  const order: string[] = [];
  const groups = new Map<string, MirrorSession[]>();
  for (const r of records) {
    const key = groupable(r.workspaceLabel) ? `g:${r.workspaceLabel}` : `s:${r.sessionId}`;
    const group = groups.get(key);
    if (group === undefined) {
      order.push(key);
      groups.set(key, [r]);
    } else {
      group.push(r);
    }
  }
  return order.flatMap((k) => groups.get(k) ?? []);
}

export function createFleetRestore(opts: {
  readonly envs: readonly HerdrEnv[];
  readonly mirrorFilePath: string;
  readonly spawn: (o: SpawnOpts) => Promise<SpawnResult>;
  readonly clearPendingRestore: (envId: string) => void;
  readonly listFn?: (env: HerdrEnv) => Promise<SessionRow[]>;
  readonly sessionCwdFn?: (env: HerdrEnv, sessionId: string) => Promise<string | null>;
  readonly readMirrorFn?: (filePath: string) => FleetMirrorFile | null;
  readonly recentWindowMs?: number;
  readonly nowFn?: () => number;
}): FleetRestore {
  const list = opts.listFn ?? listSessions;
  const sessionCwd = opts.sessionCwdFn ?? readSessionCwd;
  const readMirror = opts.readMirrorFn ?? readMirrorFile;
  const recentWindowMs = opts.recentWindowMs ?? RECENT_RESUME_WINDOW_MS;
  const now = opts.nowFn ?? Date.now;
  // "<envId>:<sessionId>" → ms timestamp of the resume this process performed. Bounded by fleet
  // size — no pruning needed.
  const recent = new Map<string, number>();
  let inFlight = false;

  async function restoreEnv(env: HerdrEnv, entry: MirrorEnv | undefined, dryRun: boolean): Promise<FleetRestoreEnvReport> {
    if (entry === undefined) {
      return { error: "not_in_mirror", updatedAt: null, unmirrored: 0, sessions: [] };
    }
    // Fresh listing — the poller snapshot may predate the herdr restart.
    let liveRows: SessionRow[];
    try {
      liveRows = await list(env);
    } catch (err) {
      return {
        error: `listing failed: ${err instanceof Error ? err.message : String(err)}`,
        updatedAt: entry.updatedAt, unmirrored: 0, sessions: [],
      };
    }
    const liveIds = new Set<string>();
    for (const r of liveRows) if (r.sessionId !== null) liveIds.add(r.sessionId);
    const mirroredIds = new Set(entry.sessions.map((r) => r.sessionId));
    let unmirrored = 0;
    for (const id of liveIds) if (!mirroredIds.has(id)) unmirrored += 1;

    const sessions: FleetRestoreSession[] = [];
    let failed = 0;
    for (const rec of orderByWorkspace(entry.sessions)) {
      const outcomeOf = await restoreRecord(env, rec, liveIds, dryRun);
      sessions.push(outcomeOf);
      if (outcomeOf.outcome === "failed") failed += 1;
    }
    if (!dryRun && failed === 0) opts.clearPendingRestore(env.id);
    return { error: null, updatedAt: entry.updatedAt, unmirrored, sessions };
  }

  async function restoreRecord(
    env: HerdrEnv, rec: MirrorSession, liveIds: ReadonlySet<string>, dryRun: boolean,
  ): Promise<FleetRestoreSession> {
    const base = { sessionId: rec.sessionId, name: rec.name };
    // Schema-pinned on read, re-tested here: this string reaches `--resume ${id}` in an unquoted
    // shell interpolation. Fail secure — never spawned.
    if (!UUID_RE.test(rec.sessionId)) {
      return { ...base, outcome: "failed", error: "sessionId is not a uuid — refusing to spawn" };
    }
    if (liveIds.has(rec.sessionId)) {
      return { ...base, outcome: "skipped_alive", error: null };
    }
    const recentKey = `${env.id}:${rec.sessionId}`;
    const resumedAt = recent.get(recentKey);
    if (resumedAt !== undefined && now() - resumedAt < recentWindowMs) {
      return { ...base, outcome: "skipped_recent", error: null };
    }
    if (dryRun) {
      // Inventory, not a rehearsal: no cwd probe, no workspace resolution.
      return { ...base, outcome: "would_resume", error: null };
    }
    // Probe the transcript for the real cwd; pane-cwd fallback (same reasoning as the per-link
    // resume route: `claude --resume` is cwd-scoped).
    let probed: string | null = null;
    try {
      probed = await sessionCwd(env, rec.sessionId);
    } catch {
      probed = null;
    }
    const resolved = probed ?? rec.cwd;
    const nameSlug = slugify(rec.name, NAME_MAX);
    const sessionName = nameSlug !== "" ? nameSlug : `restored-${rec.sessionId.slice(0, 8)}`;
    const grouped = groupable(rec.workspaceLabel);
    try {
      await opts.spawn({
        env,
        // Workspace-label fallback for the solo (placeholder-label) create path: the session's own
        // name. sanitizeSlug caps it at 32 chars — a >32-char tab name yields a truncated solo
        // workspace label, the same truncation the per-link resume route already accepts.
        taskSlug: sanitizeSlug(sessionName),
        // BOTH cwd and repoPath get the resolved path, deliberately: the create-workspace branch
        // (taken by the FIRST session of every group on an empty post-upgrade herdr) reads ONLY
        // repoPath; the join+resume branch reads ONLY cwd.
        cwd: resolved,
        repoPath: resolved,
        // Resolve-by-label (targetWorkspaceId ABSENT): first of a group creates the workspace,
        // siblings join it. NOT the per-link route's targetWorkspaceId shape — every stored id is
        // dead after a herdr restart, and that path would land N sessions in N workspaces.
        repo: grouped ? rec.workspaceLabel : null,
        assignedPaneIds: new Set<string>(),
        // Explicit, as the per-link resume route does: an env with a custom spawn command must not
        // silently fall back to "claude".
        spawnCommand: env.spawnCommand,
        resumeSessionId: rec.sessionId,
        sessionName,
      });
      recent.set(recentKey, now());
      return { ...base, outcome: "resumed", error: null };
    } catch (err) {
      return { ...base, outcome: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    async run(req) {
      // Validation before the in-flight guard — a deliberate, FLAGGED divergence from the spec's
      // literal "a second POST while one runs → 409": an unknown env can never spawn, so the guard's
      // purpose (no concurrent double-resume) is untouched, and diagnosing the typo beats a 409
      // even mid-restore. A typo must not become a silent empty "success".
      if (req.env !== undefined && !opts.envs.some((e) => e.id === req.env)) {
        return { status: "unknown_env", env: req.env };
      }
      if (inFlight) return { status: "in_flight" };
      inFlight = true;
      try {
        let mirror: FleetMirrorFile | null;
        try {
          mirror = readMirror(opts.mirrorFilePath);
        } catch (err) {
          return { status: "mirror_unreadable", message: err instanceof Error ? err.message : String(err) };
        }
        if (mirror === null) return { status: "no_mirror" };
        const dryRun = req.dryRun === true;
        const targets = opts.envs.filter((e) =>
          req.env !== undefined ? e.id === req.env : mirror.envs[e.id] !== undefined);
        const report: FleetRestoreReport = { dryRun, envs: {} };
        // Sequential across envs and records — restore spawns processes; no fan-out.
        for (const env of targets) {
          report.envs[env.id] = await restoreEnv(env, mirror.envs[env.id], dryRun);
        }
        return { status: "ok", report };
      } finally {
        inFlight = false;
      }
    },
  };
}
