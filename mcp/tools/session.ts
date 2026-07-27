import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CorralClient } from "../client.ts";
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
}

export interface CloseArgs {
  readonly target?: string | undefined;
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
    // Same-env continuation JOINS the caller's workspace: the new tab lands beside the caller (same
    // cwd family — a worktree checkout stays visible), repo-less cards work, and the idempotent
    // rejoin applies. Cross-env keeps the create-new path — the caller's workspace does not exist
    // over there, so it is rooted at the card repo's configured path.
    const sameEnv = env === me.session.env && me.session.workspaceId !== "";
    const result = await deps.client.spawn({
      boardId: card.boardId,
      taskId: card.taskId,
      env,
      brief: args.brief,
      ...(sameEnv ? { targetWorkspaceId: me.session.workspaceId } : {}),
    });
    const key = `${result.env}:${result.paneId}`;
    return `spawned ${result.name} on ${card.boardId}/${card.taskId} in ${result.env} — target key ${key}. It will read the brief and call corral_whoami on start.`;
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
    const cardSid = me.task?.sessions.find((s) => s.key === key)?.sessionId ?? null;
    await deps.client.closeSession({
      boardId: card.boardId,
      taskId: card.taskId,
      env,
      paneId,
      sessionId: isSelf ? me.session.sessionId : cardSid,
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
        "Start a NEW Claude session attached to THIS session's card — for a context handoff or a parallel strand. The brief is the text the new session begins from; write it as a full handoff. Defaults to this session's environment, where the new session joins THIS session's workspace; `env` overrides it, and a cross-environment spawn creates a new workspace rooted at the card's repo as configured over there. A brief is only available for local environments.",
      inputSchema: {
        brief: z.string().describe("handoff text the new session starts from; required"),
        env: z.string().optional().describe("environment id from corral_whoami; defaults to this session's"),
      },
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
    },
    async (args: CloseArgs) => toolText(await closeHandler(deps, args)),
  );
}
