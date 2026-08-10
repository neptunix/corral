import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { CorralError, type CorralClient } from "../client.ts";
import { formatRepoRefusal, formatSpawnReply } from "../digest.ts";
import type { Identity } from "../identity.ts";
import { runTool, toolText } from "./reply.ts";

export interface SessionDeps {
  readonly client: CorralClient;
  readonly identity: Identity;
}

// Optional members carry an explicit `| undefined` — see the FleetArgs note in mcp/tools/fleet.ts.
export interface SpawnArgs {
  readonly brief: string;
  readonly env?: string | undefined;
  readonly name?: string | undefined;
  readonly model?: string | undefined;
  readonly remoteControl?: boolean | undefined;
  readonly repo?: string | undefined;
}

export interface CloseArgs {
  readonly target?: string | undefined;
}

/** The target environment's configured repository names, or null when they could not be read —
 *  a refusal that says so is better than one that invents a target. Called only on a refusal path,
 *  so the happy path pays nothing for it. */
async function configuredRepos(client: CorralClient, env: string): Promise<string[] | null> {
  try {
    return await client.spawnTargets(env);
  } catch {
    return null;
  }
}

export function spawnHandler(deps: SessionDeps, args: SpawnArgs): Promise<string> {
  return runTool(async () => {
    // requireCard() first: an unbound session with a blank brief is more usefully told to bind
    // (which it must do regardless of what the brief says) than told about the brief.
    const card = await deps.identity.requireCard();
    if (args.brief.trim() === "") {
      return "a brief is required — write the handoff text the new session should start from";
    }
    const me = await deps.identity.load();
    const env = args.env ?? me.session.env;
    // brief is mandatory in this tool's schema, and the server rejects ANY spawn that carries a
    // brief when the target env isn't local (brief delivery writes a file on the corral host and
    // relies on a `$(cat …)` substitution in the pane's own shell — neither exists for a remote
    // box). A remote `env` here would therefore always 400 server-side; refuse it here instead, with
    // a message that explains why, rather than let the tool advertise an override it can never honor.
    const targetEnv = me.envs.find((e) => e.id === env);
    if (targetEnv !== undefined && targetEnv.kind !== "local") {
      return `corral_spawn only supports local environments in this phase — "${env}" is remote, and a brief cannot be delivered there (the server would refuse it). Omit env to spawn in this session's own environment, or pick a local one from corral_whoami's environment list.`;
    }
    // Two modes, and `repo` picks between them. Omitted: continue where the caller is — the new tab
    // joins the caller's own workspace, so a worktree checkout stays visible and the idempotent
    // rejoin applies. Given: work in that project, which is the route's resolve-by-repo shape.
    //
    // When `repo` is present targetWorkspaceId is NOT sent — without that, the single most likely
    // use of the parameter (corral_spawn({repo: "other-project"}) from inside another project)
    // would land beside the caller with `repo` discarded.
    const repo = args.repo !== undefined && args.repo.trim() !== "" ? args.repo : null;
    const sameEnv = env === me.session.env && me.session.workspaceId !== "";
    // No workspace to continue in and no repo named: there is no target at all, and corral does not
    // infer one. Decided here rather than server-side because only this session knows whether it has
    // a workspace of its own — and because a value RETURNED is not truncated the way a thrown
    // CorralError is (mcp/tools/reply.ts), which is what would eat the list of names.
    if (repo === null && !sameEnv) {
      return formatRepoRefusal({ env, repo: null, repos: await configuredRepos(deps.client, env) });
    }
    let result: Awaited<ReturnType<CorralClient["spawn"]>>;
    try {
      result = await deps.client.spawn({
        boardId: card.boardId,
        taskId: card.taskId,
        env,
        brief: args.brief,
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.remoteControl === undefined ? {} : { remoteControl: args.remoteControl }),
        ...(repo !== null ? { repo } : { targetWorkspaceId: me.session.workspaceId }),
      });
    } catch (err) {
      // Matched on THAT code alone. Every other bad field on this route returns `validation`, so a
      // broader match would answer "unknown repository" to a bad model id or an unknown env.
      if (err instanceof CorralError && err.code === "unknown_repo") {
        return formatRepoRefusal({ env, repo, repos: await configuredRepos(deps.client, env) });
      }
      throw err;
    }
    return formatSpawnReply({
      name: result.name, boardId: card.boardId, taskId: card.taskId,
      env: result.env, paneId: result.paneId,
      workspaceLabel: result.workspaceLabel, cwdSnapshot: result.cwdSnapshot,
      idempotent: result.idempotent,
    });
  });
}

export function closeHandler(deps: SessionDeps, args: CloseArgs): Promise<string> {
  return runTool(async () => {
    const card = await deps.identity.requireCard();
    const me = await deps.identity.load();
    const selfKey = `${me.session.env}:${me.session.paneId}`;

    const target = args.target ?? "self";
    let key: string;
    if (target === "self") {
      key = selfKey;
    } else {
      const cut = target.indexOf(":");
      if (cut <= 0 || cut === target.length - 1) {
        return `target must be "self" or "env:paneId" — got "${target}"`;
      }
      key = target;
      // Close rights follow CARD MEMBERSHIP, held server-side (owner decision 2026-07-27, supersedes
      // the earlier process-local spawned-set): any session attached to this card is a valid target
      // and the right survives MCP restarts. The balance: close is suspend-not-destroy (link stays,
      // `--resume` restores), every call passes the operator's permission prompt, and whoami shows
      // the target's live status first. Off-card targets are the phase-2 orchestrator role.
      const onCard = me.task?.sessions.some((s) => s.key === key) ?? false;
      if (key !== selfKey && !onCard) {
        return `refusing to close ${key}: it is not attached to this session's card. Closing sessions on other cards is not available.`;
      }
    }

    const cut = key.indexOf(":");
    const env = key.slice(0, cut);
    const paneId = key.slice(cut + 1);
    const isSelf = key === selfKey;
    // A spawned target's UUID was unknown at spawn time (Claude registers after launch), but by now
    // the card list carries it — pass it as sid so the server resolves the exact link, not just the
    // pane. Self defers the pane kill so this response outruns the pane's death (spec §5.4).
    //
    // Always the LINK's stored id, never the live row's (me.session.sessionId), even for self: an
    // explicit sid is authoritative in resolveLinkIndex with NO paneId fallback (server/session-
    // binding.ts). While a fresh link's sessionId is still null — the window before the reconciler
    // backfills it, or any time a backfill write fails — the live UUID matches nothing and a
    // self-close 404s "session not linked" while the session stays alive. Falling back to null here
    // instead restores the paneId + churn-heal resolution path.
    //
    // Self resolves via the card list's own `self` flag (linkBindsSession, computed server-side in
    // whoami.ts), NOT by `key`: two links can share a pane on the same card — a stale detached link
    // left behind by a same-pane `/new` plus the rebound live one (server/api.ts's isSessionBound
    // comment documents this as intended). `find(key)` returns whichever is stored first, usually
    // the stale one, and sending ITS sessionId as an authoritative sid no longer matches the live
    // row — a 409 pane_reused telling the caller its own pane belongs to someone else. Non-self
    // keeps key-based lookup; its own ambiguity in that same two-link state is pre-existing and out
    // of scope here (there is no equivalent `self`-shaped disambiguator for an arbitrary target).
    const cardSid = isSelf
      ? me.task?.sessions.find((s) => s.self)?.sessionId ?? null
      : me.task?.sessions.find((s) => s.key === key)?.sessionId ?? null;
    await deps.client.closeSession({
      boardId: card.boardId,
      taskId: card.taskId,
      env,
      paneId,
      sessionId: cardSid,
      deferred: isSelf,
    });
    return isSelf
      ? `close scheduled for ${key} — this pane will terminate momentarily. The card keeps the link and renders detached, so the session can be resumed from the corral UI.`
      : `closed ${key}. The card keeps the link and renders detached, so the session can be resumed from the corral UI.`;
  });
}

export function registerSessionTools(server: McpServer, deps: SessionDeps): void {
  server.registerTool(
    "corral_spawn",
    {
      title: "Spawn a session on this card",
      description:
        "Start a NEW Claude session attached to THIS session's card — for a context handoff or a parallel strand. The brief is the text the new session begins from; write it as a full handoff. Defaults to this session's environment; omit `repo` and the new session joins THIS session's workspace, pass `repo` and it lands in that project's own workspace instead. LOCAL ENVIRONMENTS ONLY in this phase: `env` may only name a local environment (kind=local in corral_whoami's environment list) — a brief cannot be delivered to a remote environment, so a remote `env` is refused here rather than left to 400 on the server. Supply `name`, and supply the WHOLE name: corral uses your string verbatim as the Claude session name, the herdr tab label and the card's label — it no longer prefixes anything. Write it as `{slug}-{name}`, where `{slug}` is a very short label for the card (reuse the slug of your OWN session name when you have one, so the card's sessions cluster) and `{name}` is two to four words for what THIS session does. Destructive: this starts a real session that consumes tokens.",
      inputSchema: {
        brief: z.string().describe("handoff text the new session starts from; required"),
        env: z.string().optional().describe("LOCAL environment id from corral_whoami; defaults to this session's. A remote environment is refused."),
        repo: z.string().optional().describe(
          "omit to continue where you are — the new session lands beside this one, in this session's own workspace. Pass it to work in a DIFFERENT project: the session lands in that project's workspace, at its repository root. The value must be a repository name configured for the target environment; a name that is not configured is refused with the list of the ones that are."),
        name: z.string().max(128).optional().describe(
          'the COMPLETE session name as `{slug}-{name}`, e.g. "wm-stake-rc-toggle-ui" — corral uses it verbatim and adds no prefix. ASCII lowercase letters, digits and dashes ONLY, because this value becomes a command-line flag and a terminal tab label, not prose: anything outside [a-z0-9-] is stripped, and a name written in a non-Latin script reduces to nothing and is treated as if you had omitted it. Aim for 56 characters or fewer in total so it stays readable in a tab bar and the /resume picker. Omit only if you genuinely cannot say — corral then derives a name from the card, which is far less useful than yours.'),
        model: z.string().optional().describe(
          'model for the new session: an alias ("fable", "opus", "sonnet") or a full id. Omit to inherit the model this environment last used. corral does not validate the value beyond its shape — a wrong one starts a session that fails at the API.'),
        remoteControl: z.boolean().optional().describe(
          'start the session with Remote Control already connected, so it is reachable from claude.ai. Default off. Use it when you are spawning on behalf of an operator working from a session that is itself remote — otherwise the new session cannot be reached from where it was asked for. Requires claude.ai subscription auth on that machine; without it the session still starts and asks for authorization inside.'),
      },
      // Machine-readable counterpart to the "Destructive." in the descriptions below — a harness can
      // gate on this without parsing prose. It changes nothing on its own: the actual control is the
      // operator declining to allowlist these two tools.
      annotations: { destructiveHint: true },
    },
    async (args: SpawnArgs) => toolText(await spawnHandler(deps, args)),
  );

  server.registerTool(
    "corral_session_close",
    {
      title: "Close this session or one it spawned",
      description:
        'Stop a Claude session: kills its pane but KEEPS the card link, so the card shows it as detached and it stays resumable. Target is "self" (default) or the "<env>:<paneId>" key of any session attached to the SAME card, as listed by corral_whoami — check its status there first; "working" means mid-task. Off-card targets are refused. Closing self ends THIS session, so make it the last action. Destructive.',
      inputSchema: {
        target: z.string().optional().describe('"self" (default) or "<env>:<paneId>"'),
      },
      annotations: { destructiveHint: true },
    },
    async (args: CloseArgs) => toolText(await closeHandler(deps, args)),
  );
}
