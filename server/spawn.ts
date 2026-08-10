import type { SessionRow } from "@shared/schema";
import { quote } from "shell-quote";

import type { HerdrEnv } from "../environments.ts";
import { BRIEF_FALLBACK } from "./brief.ts";
import type { ExecFn } from "./herdr.ts";
import {
  listPanes, paneGet, paneRun, tabClose, tabCreate, tabRename, workspaceClose, workspaceCreate,
} from "./herdr.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// The ONE string used as the herdr tab label, the card's link name, `claude --name` and
// `--remote-control <name>`. Nothing downstream imposes this bound: Claude Code stored a 148-char
// name verbatim and herdr a 239-char tab label. 96 is corral's own HARD cap, chosen so a name the
// AGENT wrote is not silently cut. The agent-facing contracts ask for ~56 instead — a tidier target
// with headroom above it, not a second bound; only this one truncates.
export const NAME_MAX = 96;
// DERIVED, never hand-written. This regex is the final gate on every candidate (see the find() in
// composeSessionName), and it used to spell out `{0,55}` — NAME_MAX - 1 for the old 56. Raising
// NAME_MAX alone therefore rejected every longer name, composeSessionName returned null, and the
// route answered 409 "no free session name left on this task" for a card with no sessions at all.
const NAME_RE = new RegExp(`^[a-z0-9][a-z0-9-]{0,${String(NAME_MAX - 1)}}$`);

// The a-z candidate letters a colliding name is disambiguated by, appended to whichever base
// composeSessionName is working from: `${name}-<letter>` or `${fallbackPrefix}-<letter>`.
const SESSION_LETTERS: readonly string[] =
  Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i));

/**
 * Slug, or "" when nothing usable survives — callers read "" as "not supplied".
 *
 * The pipeline alone guarantees the launch-flag charset, so there is deliberately NO trailing
 * validity check: every surviving character is already `[a-z0-9-]`; leading dashes are trimmed
 * BEFORE the slice and a slice keeps a prefix, so the first character can never be a dash; and the
 * final replace removes a dash the cut may have left. A `/^[a-z0-9][a-z0-9-]*$/` guard here used to
 * sit on the return and was dead code — it cannot reject anything this function can produce (fuzzed
 * over 800k inputs, it never once changed the result). Do not add it back.
 */
export function slugify(text: string, max: number): string {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

// UNCHANGED. An earlier revision truncated this to 24 characters, which silently changed the slug for
// every card title over 32 characters and broke the idempotent-rejoin key for cards that already
// exist. Other call sites depend on both the 32 and the "task" fallback.
export function sanitizeSlug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return SLUG_RE.test(s) ? s : "task";
}

/**
 * The prefix a session name falls back to when nothing usable was supplied — the agent omitted
 * `name`, wrote it in a script the charset cannot carry, or the spawn came from the UI, which sends
 * no name at all. Ordered most-meaningful first, and EVERY step is slugified.
 *
 * The title is tested via `slugify`, not via `sanitizeSlug`'s "task" sentinel: a card genuinely
 * titled "Task" would otherwise be misread as the degenerate case. `sanitizeSlug` is left alone — it
 * is the idempotent-rejoin key and must not change.
 */
export function fallbackNamePrefix(title: string, repo: string | null, taskId: string): string {
  const titleSlug = slugify(title, 32);
  if (titleSlug !== "") return titleSlug;
  const repoSlug = repo === null ? "" : slugify(repo, 32);
  if (repoSlug !== "") return repoSlug;
  return slugify(taskId, 32);
}

/**
 * The requested name IS the session name — corral no longer prefixes it with the card's slug.
 * Returns the first candidate `isFree` accepts, or null when none is both free and valid (the route
 * then 409s).
 *
 * The agent that spawns holds what the old mechanical prefix was approximating: the card's meaning,
 * and its own session's slug. It supplies the whole `{slug}-{name}`, so corral's job here is only to
 * reduce to the launch-flag charset, cap, and disambiguate. A prefix derived from the card title
 * spent the caller's length budget first (truncation eats the tail, i.e. the informative half) and
 * degenerated to "task" for any title without Latin characters.
 *
 * `fallbackPrefix` is used ONLY when nothing usable survives in `requested` — the agent omitted the
 * name, or wrote it in a script the charset cannot carry. It is slugified HERE rather than trusted
 * from the caller, so the charset guarantee holds however the route derived it: the chain's last
 * resort is `task.id`, and a raw `t_${nanoid(7)}` fails NAME_RE every single time ("_" is not in the
 * charset — measured 2000/2000).
 *
 * INVARIANT: the string handed to `isFree` is byte-identical to the string returned. Every candidate
 * is truncated to NAME_MAX and re-trimmed BEFORE the test, never after — two design revisions had
 * this backwards and could hand back a truncated name that collided with one already taken. `isFree`
 * is a callback rather than a Set so that rule lives in exactly one place and is unit-testable
 * without the route.
 */
export function composeSessionName(
  fallbackPrefix: string,
  requested: string,
  isFree: (name: string) => boolean,
): string | null {
  const candidates: string[] = [];
  const nameSlug = slugify(requested, NAME_MAX);
  // EITHER/OR. Appending both families let an exhausted requested name fall through to a card-derived
  // one, so the route answered 200 with a name the agent never asked for instead of 409.
  if (nameSlug !== "") {
    candidates.push(nameSlug);
    // Pre-trimmed by 2 so the disambiguating letter can never be the part truncation eats.
    const base = slugify(requested, NAME_MAX - 2);
    for (const letter of SESSION_LETTERS) candidates.push(`${base}-${letter}`);
  } else {
    const prefix = slugify(fallbackPrefix, NAME_MAX - 2);
    if (prefix !== "") {
      for (const letter of SESSION_LETTERS) candidates.push(`${prefix}-${letter}`);
    }
  }
  return candidates.find((c) => NAME_RE.test(c) && isFree(c)) ?? null;
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
  // Absolute path to a brief file on the pane's own host. When set (and not resuming), the launch
  // command reads it through the pane's shell, so the brief's bytes never enter a command string —
  // only this server-generated, shell-quoted path does. Local environments only (the route enforces
  // that): the file lives on the corral host, and `cat` would otherwise run on a remote box.
  readonly briefPath?: string;
  /** What the pane shows when the shell cannot read the brief file. Defaults to BRIEF_FALLBACK, whose
   *  wording is about a LOST HANDOFF — wrong for a start command, where nothing was handed off and no
   *  prior session authored the text. Kept as an option rather than a second branch in the command
   *  builder so the fallback stays a single interpolation point. Apostrophe-free: it is embedded in a
   *  single-quoted shell word. */
  readonly briefFallback?: string;
  /**
   * THREE-state, and the three states are not interchangeable:
   *   - a workspace id → join that workspace;
   *   - explicit `null` → create a new workspace at `repoPath`;
   *   - ABSENT → resolve `repo` to its workspace: join the space labelled with the repo key if one
   *     exists, else create at `repoPath`.
   * The route passes the caller's shape straight through; do not collapse absent to null here.
   */
  readonly targetWorkspaceId?: string | null;
  readonly repoPath?: string | null;              // resolved env.repos[repo]; required to create
  /** The one string used as the herdr tab label, `--name`, and `--remote-control`'s name. Composed by
   *  the route (composeSessionName), which owns the whole fallback chain.
   *
   *  REQUIRED, deliberately. It used to be optional with `?? `${taskSlug}-a`` filling in here — a
   *  SECOND, independent fallback that the route's chain could not reach. The resume path relied on
   *  it (it omitted the name when the stored one had nothing usable left), so a card whose title
   *  carries no Latin characters resumed as `task-a` no matter what the route decided. One name
   *  source, in the route. */
  readonly sessionName: string;
  /** Shape-validated in the spawn route's body schema (A.5). corral keeps no allowlist. */
  readonly model?: string;
  /** Start with Remote Control connected. Default OFF — this connects the session to claude.ai, so it
   *  is an explicit per-spawn decision on both the UI and MCP paths (spec A.1). */
  readonly remoteControl?: boolean;
  // Injectable for testing
  readonly listFn?: (env: HerdrEnv, exec?: ExecFn) => Promise<SessionRow[]>;
  readonly paneGetFn?: (env: HerdrEnv, paneId: string, exec?: ExecFn) => Promise<{ paneId: string; tabId: string; workspaceId: string; cwd: string }>;
  readonly paneRunFn?: (env: HerdrEnv, paneId: string, text: string, exec?: ExecFn) => Promise<void>;
  readonly workspaceCreateFn?: (env: HerdrEnv, cwd: string, label: string, exec?: ExecFn) => Promise<{ workspaceId: string; rootTabId: string | undefined; rootPaneId: string | undefined }>;
  readonly tabCreateFn?: (env: HerdrEnv, workspaceId: string, cwd: string, label: string, exec?: ExecFn) => Promise<{ tabId: string; paneId: string }>;
  readonly tabRenameFn?: (env: HerdrEnv, tabId: string, label: string, exec?: ExecFn) => Promise<void>;
  readonly tabCloseFn?: (env: HerdrEnv, tabId: string, exec?: ExecFn) => Promise<void>;
  readonly workspaceCloseFn?: (env: HerdrEnv, workspaceId: string, exec?: ExecFn) => Promise<void>;
  readonly workspaceListFn?: (env: HerdrEnv) => Promise<{ workspace_id: string; label: string }[]>;
  /** Listing used ONLY to resolve a repo to its workspace. Deliberately separate from
   *  `workspaceListFn`, and deliberately without a default: that path reads "no space carries this
   *  label" as "create one", so a listing that silently degraded to `[]` — the lenient parser, or
   *  the no-op default above — would create a second workspace for a repository that already has
   *  one. Wire `listWorkspacesStrict` (server/index.ts does); absent, resolution refuses. */
  readonly workspaceListStrictFn?: (env: HerdrEnv) => Promise<{ workspace_id: string; label: string }[]>;
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

  // The tab label must agree with the idempotency key below, else re-spawn can't rejoin. Taken
  // verbatim: the route is the only place a name is derived.
  const tabName = opts.sessionName;

  // Flags, in a fixed order so tests can assert exact strings. --remote-control ALWAYS carries the
  // name: its argument is optional, so a bare flag would consume the positional brief that follows and
  // start a session with no prompt (spec Findings). Passing the name fills the slot.
  const flags = [
    "--name", tabName,
    ...(opts.model !== undefined ? ["--model", opts.model] : []),
    ...(opts.remoteControl === true ? ["--remote-control", tabName] : []),
  ];
  const launch = `${spawnCommand} ${quote(flags)}`;

  const command = opts.resumeSessionId !== undefined
    // Resume sends NO flags: the name lives in the transcript and the model is restored with the
    // session, so re-sending either would overwrite a choice the user may have made since; and a
    // resumed session must not silently re-connect to claude.ai (spec A.4).
    ? `${spawnCommand} --resume ${opts.resumeSessionId}`
    : opts.briefPath !== undefined
      // Three things happen inside the ONE substitution, in order:
      //   cat   — read the brief, which is what becomes the session's first message.
      //   ||    — if that read fails, substitute a message saying so. Without it the expansion is
      //           the empty string and the pane silently launches with no brief at all.
      //   rm -f — delete the file, caused by the read rather than racing it on a timer. `rm` prints
      //           nothing, so it does not contribute to the expansion.
      // The server-side unlink (server/api.ts) remains only as a backstop for a pane that never
      // runs this command at all. ADR-0002 §5 decided this shape deliberately — do NOT move the `rm`
      // out of the substitution (spec A.7 is withdrawn).
      ? `${launch} "$(cat ${quote([opts.briefPath])} || printf '%s' ${quote([opts.briefFallback ?? BRIEF_FALLBACK])}; rm -f ${quote([opts.briefPath])})"`
      : launch;
  const repoPath = opts.repoPath ?? null;

  const doList = opts.listFn ?? ((e: HerdrEnv) => import("./herdr.ts").then((h) => h.listSessions(e)));
  const doWorkspaceList = opts.workspaceListFn ?? defaultWorkspaceList;
  const doListPanes = opts.listPanesFn ?? listPanes;
  const doPaneGet = opts.paneGetFn ?? paneGet;
  const doPaneRun = opts.paneRunFn ?? paneRun;
  const doWorkspaceCreate = opts.workspaceCreateFn ?? workspaceCreate;
  const doTabCreate = opts.tabCreateFn ?? tabCreate;
  const doTabRename = opts.tabRenameFn ?? tabRename;
  const doTabClose = opts.tabCloseFn ?? tabClose;
  const doWorkspaceClose = opts.workspaceCloseFn ?? workspaceClose;

  // Step 0: an ABSENT targetWorkspaceId means "the workspace of this repository". Look it up by
  // label — the model is one workspace per repository — rather than guessing. The listing is reused
  // by the join branch below so the label costs no second round-trip.
  let targetWorkspaceId: string | null = opts.targetWorkspaceId ?? null;
  let resolvedSpaces: { workspace_id: string; label: string }[] | null = null;
  // Non-null only when the caller named the repo: then the CONFIGURED path roots the new tab, not
  // whatever directory the matched space's existing panes happen to sit in.
  let repoRootCwd: string | null = null;
  if (opts.targetWorkspaceId === undefined && repo !== null && repoPath !== null) {
    const doWorkspaceListStrict = opts.workspaceListStrictFn;
    if (doWorkspaceListStrict === undefined) {
      throw new Error("spawn: resolving a workspace by repo needs workspaceListStrictFn — none was wired");
    }
    resolvedSpaces = await doWorkspaceListStrict(env);
    const key = repo.toLowerCase();
    // Lexicographically smallest id on a tie, so a retry makes the same choice and rejoins the
    // session it started rather than opening a second one beside it.
    targetWorkspaceId = resolvedSpaces
      .filter((w) => w.label.toLowerCase() === key)
      .map((w) => w.workspace_id)
      .sort()[0] ?? null;
    repoRootCwd = repoPath;
  }

  // Step 1: resolve the target workspace (join existing, or create a new one at repoPath).
  let workspaceId: string;
  let workspaceLabel: string;
  let tabCwd: string;
  let createdWorkspaceId: string | null = null;
  // When we CREATE the workspace, herdr seeds a root tab + pane; reuse it (§ Step 3) rather than
  // leaving it empty and making a second tab. Null on the join path, or if herdr returns no root pane.
  let rootTab: { tabId: string; paneId: string } | null = null;

  if (targetWorkspaceId !== null) {
    // Join: label from the picked workspace, cwd from one of its panes (a custom space's own path,
    // not the repo path). panes[0].cwd is a heuristic when panes disagree; guarded fallbacks follow.
    workspaceId = targetWorkspaceId;
    const allWss = resolvedSpaces ?? await doWorkspaceList(env);
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
          const created = await doWorkspaceCreate(env, cwd, workspaceLabel);
          workspaceId = created.workspaceId;
          createdWorkspaceId = workspaceId;
          rootTab = created.rootTabId !== undefined && created.rootPaneId !== undefined
            ? { tabId: created.rootTabId, paneId: created.rootPaneId } : null;
        } catch (err) {
          throw new Error(`spawn: workspace create failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      const panes = await doListPanes(env, workspaceId);
      tabCwd = repoRootCwd ?? panes[0]?.cwd ?? repoPath ?? cwd;

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
      const created = await doWorkspaceCreate(env, repoPath, workspaceLabel);
      workspaceId = created.workspaceId;
      createdWorkspaceId = workspaceId;
      rootTab = created.rootTabId !== undefined && created.rootPaneId !== undefined
        ? { tabId: created.rootTabId, paneId: created.rootPaneId } : null;
    } catch (err) {
      throw new Error(`spawn: workspace create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 3: land in a tab named `tabName`, each holding a ready interactive-shell pane. On a create
  // path the workspace already seeded a root tab — reuse it (rename) so we don't leave it empty and
  // spawn a second one. On the join path (or older herdr that returns no root pane) create a tab.
  let tabId: string;
  let paneId: string;
  if (rootTab !== null) {
    try {
      await doTabRename(env, rootTab.tabId, tabName);
    } catch (err) {
      if (createdWorkspaceId !== null) await doWorkspaceClose(env, createdWorkspaceId).catch(() => void 0);
      throw new Error(`spawn: tab rename failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    tabId = rootTab.tabId;
    paneId = rootTab.paneId;
  } else {
    try {
      ({ tabId, paneId } = await doTabCreate(env, workspaceId, tabCwd, tabName));
    } catch (err) {
      if (createdWorkspaceId !== null) await doWorkspaceClose(env, createdWorkspaceId).catch(() => void 0);
      throw new Error(`spawn: tab create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 4: launch Claude by sending the per-env command into the interactive shell.
  try {
    await doPaneRun(env, paneId, command, undefined);
  } catch (err) {
    // Cleanup: closing a workspace we created drops its tab (reused or fresh) too, so it's the only
    // call needed there; on the join path close just the tab we added to the user's workspace.
    if (createdWorkspaceId !== null) await doWorkspaceClose(env, createdWorkspaceId).catch(() => void 0);
    else await doTabClose(env, tabId).catch(() => void 0);
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
