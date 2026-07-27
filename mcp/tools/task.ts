import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CorralClient, TaskPatch } from "../client.ts";
import { formatTaskPicker } from "../digest.ts";
import type { Identity } from "../identity.ts";
import { runTool, toolText } from "./reply.ts";

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
      return `this session is already bound to ${me.task.boardId}/${me.task.taskId} ("${me.task.title}"). Rebinding is not available; detach from the corral UI first if that is what you want.`;
    }
    if (args.boardId === undefined && args.taskId === undefined) {
      return formatTaskPicker(await deps.client.boards());
    }
    if (args.boardId === undefined) return "boardId is required alongside taskId — call with no arguments to list open cards";
    if (args.taskId === undefined) return "taskId is required alongside boardId — call with no arguments to list open cards";

    await deps.client.attach({
      boardId: args.boardId,
      taskId: args.taskId,
      env: me.session.env,
      paneId: me.session.paneId,
      // Never empty: corral renders a detached card as "⚠ {name}", and a blank name reads as a bug.
      name: me.session.sessionName ?? me.session.tabLabel,
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
    return `updated ${card.boardId}/${card.taskId}: status=${task.status} priority=${task.priority ?? "none"} title="${task.title}"`;
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
