import type { SessionRow } from "@shared/schema";

import type { HerdrEnv } from "../environments.ts";
import type { ExecFn } from "./herdr.ts";
import {
  listPanes, paneGet, paneRun, tabClose, tabCreate, workspaceClose, workspaceCreate,
} from "./herdr.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function sanitizeSlug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return SLUG_RE.test(s) ? s : "task";
}

export interface SpawnOpts {
  readonly env: HerdrEnv;
  readonly taskSlug: string;
  readonly cwd: string;
  readonly repo: string | null;
  readonly assignedPaneIds: ReadonlySet<string>;
  // Part A/B: which command to send, and where to land.
  readonly spawnCommand?: string;                 // default "claude"
  readonly resumeSessionId?: string;   // when set: run `${spawnCommand} --resume <uuid>` and force the tab cwd
  readonly sessionSuffix?: string;                // tab suffix a|b|c for a task's Nth session (default "a")
  readonly targetWorkspaceId?: string | null;     // null/absent = create a new workspace
  readonly repoPath?: string | null;              // resolved env.repos[repo]; required to create
  // Injectable for testing
  readonly listFn?: (env: HerdrEnv, exec?: ExecFn) => Promise<SessionRow[]>;
  readonly paneGetFn?: (env: HerdrEnv, paneId: string, exec?: ExecFn) => Promise<{ paneId: string; tabId: string; workspaceId: string; cwd: string }>;
  readonly paneRunFn?: (env: HerdrEnv, paneId: string, text: string, exec?: ExecFn) => Promise<void>;
  readonly workspaceCreateFn?: (env: HerdrEnv, cwd: string, label: string, exec?: ExecFn) => Promise<string>;
  readonly tabCreateFn?: (env: HerdrEnv, workspaceId: string, cwd: string, label: string, exec?: ExecFn) => Promise<{ tabId: string; paneId: string }>;
  readonly tabCloseFn?: (env: HerdrEnv, tabId: string, exec?: ExecFn) => Promise<void>;
  readonly workspaceCloseFn?: (env: HerdrEnv, workspaceId: string, exec?: ExecFn) => Promise<void>;
  readonly workspaceListFn?: (env: HerdrEnv) => Promise<{ workspace_id: string; label: string }[]>;
  readonly listPanesFn?: (env: HerdrEnv, workspaceId: string, exec?: ExecFn) => Promise<{ paneId: string; cwd: string }[]>;
}

export interface SpawnResult {
  readonly paneId: string;
  readonly tabId: string;
  readonly workspaceId: string;
  readonly workspaceLabel: string;
  readonly tabLabel: string;
  readonly cwdSnapshot: string;
  readonly idempotent: boolean;
}

// Default no-op workspace-list fallback: returns an empty list so a join with no injected list fn
// still resolves a label. Production callers (server/index.ts) inject the real herdr list fn.
function defaultWorkspaceList(_env: HerdrEnv): Promise<{ workspace_id: string; label: string }[]> {
  return Promise.resolve([]);
}

export async function spawnSession(opts: SpawnOpts): Promise<SpawnResult> {
  const { env, taskSlug, cwd, repo, assignedPaneIds } = opts;
  const spawnCommand = opts.spawnCommand ?? "claude";
  const command = opts.resumeSessionId !== undefined
    ? `${spawnCommand} --resume ${opts.resumeSessionId}`
    : spawnCommand;
  const sessionSuffix = opts.sessionSuffix ?? "a";
  const targetWorkspaceId = opts.targetWorkspaceId ?? null;
  const repoPath = opts.repoPath ?? null;

  const doList = opts.listFn ?? ((e: HerdrEnv) => import("./herdr.ts").then((h) => h.listSessions(e)));
  const doWorkspaceList = opts.workspaceListFn ?? defaultWorkspaceList;
  const doListPanes = opts.listPanesFn ?? listPanes;
  const doPaneGet = opts.paneGetFn ?? paneGet;
  const doPaneRun = opts.paneRunFn ?? paneRun;
  const doWorkspaceCreate = opts.workspaceCreateFn ?? workspaceCreate;
  const doTabCreate = opts.tabCreateFn ?? tabCreate;
  const doTabClose = opts.tabCloseFn ?? tabClose;
  const doWorkspaceClose = opts.workspaceCloseFn ?? workspaceClose;

  // The tab herdr label and the card `name` must agree with the idempotency key, else re-spawn can't
  // rejoin. The caller (api spawn endpoint) picks the next free a|b|c suffix for the task's Nth session.
  const tabName = `${taskSlug}-${sessionSuffix}`;

  // Step 1: resolve the target workspace (join existing, or create a new one at repoPath).
  let workspaceId: string;
  let workspaceLabel: string;
  let tabCwd: string;
  let createdWorkspaceId: string | null = null;

  if (targetWorkspaceId !== null) {
    // Join: label from the picked workspace, cwd from one of its panes (a custom space's own path,
    // not the repo path). panes[0].cwd is a heuristic when panes disagree; guarded fallbacks follow.
    workspaceId = targetWorkspaceId;
    const allWss = await doWorkspaceList(env);
    const targetWs = allWss.find((w) => w.workspace_id === targetWorkspaceId);
    workspaceLabel = targetWs?.label ?? repo ?? taskSlug;
    if (opts.resumeSessionId !== undefined) {
      tabCwd = cwd; // resume: launch in the stored cwdSnapshot (claude --resume is cwd-scoped)
      // A stored workspaceId is ephemeral — closing the space (or a herdr restart reassigning ids)
      // leaves a dead id, and `tab create --workspace <dead>` fails `workspace_not_found`, which used
      // to surface as a 502 on an otherwise-resumable session. Re-create the space at cwdSnapshot:
      // `claude --resume` is cwd-scoped, so the transcript is still reachable from that path. Unlike
      // the create-new branch below this needs no repoPath — a resumed session may have no repo.
      // Relies on the caller injecting a real workspaceListFn (server/index.ts does; the no-op
      // default would report every space as missing).
      if (targetWs === undefined) {
        try {
          workspaceId = await doWorkspaceCreate(env, cwd, workspaceLabel);
          createdWorkspaceId = workspaceId;
        } catch (err) {
          throw new Error(`spawn: workspace create failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      const panes = await doListPanes(env, workspaceId);
      tabCwd = panes[0]?.cwd ?? repoPath ?? cwd;

      // Step 2 (join only): idempotency — a live tab named exactly `tabName` (the chosen suffix) that
      // already lives IN this exact workspace and isn't carded yet → rejoin it. Scope by actual pane
      // membership (id), NOT the free-form label, so two same-labeled spaces can't cross-match. Only the
      // requested suffix is rejoined; a different suffix is a distinct session and must create a new tab.
      const panesInWs = new Set(panes.map((p) => p.paneId));
      const liveSessions = await doList(env);
      const existing = liveSessions.find(
        (s) => s.tab === tabName && panesInWs.has(s.paneId) && !assignedPaneIds.has(s.paneId),
      );
      if (existing !== undefined) {
        const info = await doPaneGet(env, existing.paneId);
        return {
          paneId: info.paneId, tabId: info.tabId, workspaceId: info.workspaceId,
          workspaceLabel, tabLabel: tabName, cwdSnapshot: info.cwd, idempotent: true,
        };
      }
    }
  } else {
    if (repoPath === null) {
      throw new Error(`no path configured for repo "${repo ?? ""}" in env ${env.id} — add it to environments.json "repos" or pick an existing space`);
    }
    workspaceLabel = repo ?? taskSlug;
    tabCwd = repoPath;
    try {
      workspaceId = await doWorkspaceCreate(env, repoPath, workspaceLabel);
      createdWorkspaceId = workspaceId;
    } catch (err) {
      throw new Error(`spawn: workspace create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 3: create the tab (returns a ready interactive-shell root pane).
  let tabId: string;
  let paneId: string;
  try {
    ({ tabId, paneId } = await doTabCreate(env, workspaceId, tabCwd, tabName));
  } catch (err) {
    if (createdWorkspaceId !== null) await doWorkspaceClose(env, createdWorkspaceId).catch(() => void 0);
    throw new Error(`spawn: tab create failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 4: launch Claude by sending the per-env command into the interactive shell.
  try {
    await doPaneRun(env, paneId, command, undefined);
  } catch (err) {
    await doTabClose(env, tabId).catch(() => void 0);
    if (createdWorkspaceId !== null) await doWorkspaceClose(env, createdWorkspaceId).catch(() => void 0);
    throw new Error(`spawn: pane run failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 5: capture final pane info (best-effort). Labels are already known — we created the tab with
  // `tabName` in `workspaceLabel`, and herdr never renames them — so no extra list round-trips.
  let paneInfo: { paneId: string; tabId: string; workspaceId: string; cwd: string };
  try {
    paneInfo = await doPaneGet(env, paneId);
  } catch {
    paneInfo = { paneId, tabId, workspaceId, cwd: tabCwd };
  }

  return {
    paneId: paneInfo.paneId,
    tabId: paneInfo.tabId,
    workspaceId: paneInfo.workspaceId,
    workspaceLabel,
    tabLabel: tabName,
    cwdSnapshot: paneInfo.cwd,
    idempotent: false,
  };
}
