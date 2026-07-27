import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CorralClient, TaskPatch } from "../client.ts";
import { formatTaskPicker, oneLine, TASK_TITLE_MAX, truncate } from "../digest.ts";
import type { Identity } from "../identity.ts";
import { runTool, toolText } from "./reply.ts";

// Same "" vs undefined/null normalization as identity.ts's presentOrNull, but over `string | null`
// (sessionName's shape) rather than `string | undefined` (env vars) — a blank sessionName must
// still fall through to tabLabel, and plain `??` lets an empty string slip past.
function nonEmpty(v: string | null): string | null {
  return v === null || v === "" ? null : v;
}

/** A card title is caller-supplied free text (any session on the card can set it via
 * corral_task_update) — echoing it into a confirmation/refusal string must go through the same
 * firewall mcp/digest.ts applies to every rendered field, or one session can smuggle an unbounded,
 * newline-carrying string into another session's tool output. */
function safeTitle(title: string): string {
  return truncate(oneLine(title), TASK_TITLE_MAX);
}

export interface TaskDeps {
  readonly client: CorralClient;
  readonly identity: Identity;
}

// Optional members carry an explicit `| undefined` — see the FleetArgs note in mcp/tools/fleet.ts.
export interface BindArgs {
  readonly boardId?: string | undefined;
  readonly taskId?: string | undefined;
}

const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;

export interface UpdateArgs {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly status?: string | undefined;
  readonly priority?: (typeof PRIORITIES)[number] | null | undefined;
}

export function bindHandler(deps: TaskDeps, args: BindArgs): Promise<string> {
  return runTool(async () => {
    const me = await deps.identity.load(true);
    if (me.task !== null) {
      return `this session is already bound to ${me.task.boardId}/${me.task.taskId} ("${safeTitle(me.task.title)}"). Rebinding is not available; detach from the corral UI first if that is what you want.`;
    }
    if (args.boardId === undefined && args.taskId === undefined) {
      return formatTaskPicker(await deps.client.boards());
    }
    if (args.boardId === undefined) return "boardId is required alongside taskId — call with no arguments to list open cards";
    if (args.taskId === undefined) return "taskId is required alongside boardId — call with no arguments to list open cards";

    // Validate the pair against the real board list BEFORE it ever reaches an HTTP call: a model-
    // supplied taskId is untrusted text, not a value this module is entitled to route on, and a
    // typo'd id is a far more useful message than a 404 (or worse — see mcp/client.ts's `seg`).
    const boards = await deps.client.boards();
    const board = boards.find((b) => b.id === args.boardId);
    const task = board?.tasks.find((t) => t.id === args.taskId);
    if (task === undefined) {
      return `no open card ${args.boardId}/${args.taskId} — call corral_task_bind with no arguments to list open cards`;
    }

    await deps.client.attach({
      boardId: args.boardId,
      taskId: args.taskId,
      env: me.session.env,
      paneId: me.session.paneId,
      // Never empty: corral renders a detached card as "⚠ {name}", and a blank name reads as a bug.
      name: nonEmpty(me.session.sessionName) ?? me.session.tabLabel,
    });
    return `bound this session to ${args.boardId}/${args.taskId}`;
  });
}

export function updateHandler(deps: TaskDeps, args: UpdateArgs): Promise<string> {
  return runTool(async () => {
    const card = await deps.identity.requireCard();
    const me = await deps.identity.load();
    const columns = me.task === null ? [] : me.task.columns.map((c) => c.id);
    if (args.status !== undefined && !columns.includes(args.status)) {
      return `"${args.status}" is not a column on this board. Valid status values: ${columns.join(", ")}`;
    }
    const patch: TaskPatch = {
      ...(args.title === undefined ? {} : { title: args.title }),
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.status === undefined ? {} : { status: args.status }),
      ...(args.priority === undefined ? {} : { priority: args.priority }),
    };
    if (Object.keys(patch).length === 0) return "nothing to update — pass at least one of title, description, status, priority";
    const task = await deps.client.patchTask({ boardId: card.boardId, taskId: card.taskId, patch });
    return `updated ${card.boardId}/${card.taskId}: status=${task.status} priority=${task.priority ?? "none"} title="${safeTitle(task.title)}"`;
  });
}

export function registerTaskTools(server: McpServer, deps: TaskDeps): void {
  server.registerTool(
    "corral_task_bind",
    {
      title: "Bind this session to a card",
      description:
        "Link THIS session to an existing corral task card. Call with NO arguments to list the open cards, then call again with boardId and taskId. Refuses if this session is already bound. Creating a new card is not available.",
      inputSchema: {
        boardId: z.string().optional().describe("board id, as listed by a no-argument call"),
        taskId: z.string().optional().describe("task id, as listed by a no-argument call"),
      },
    },
    async (args: BindArgs) => toolText(await bindHandler(deps, args)),
  );

  server.registerTool(
    "corral_task_update",
    {
      title: "Update this session's card",
      description:
        "Update the card THIS session is bound to. Use `status` for the coarse board state (it must be one of the column ids corral_whoami reports) and `description` as the running progress log. Cannot target another card — there is no task id argument.",
      inputSchema: {
        title: z.string().optional(),
        description: z.string().optional().describe("full replacement body; the progress log lives here"),
        status: z.string().optional().describe("a column id from corral_whoami's task.columns"),
        priority: z.enum(PRIORITIES).nullable().optional().describe("null clears the priority"),
      },
    },
    async (args: UpdateArgs) => toolText(await updateHandler(deps, args)),
  );
}
