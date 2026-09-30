import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DESCRIPTION_REV_RE } from "../../shared/description-rev.ts";
import { CorralError, type TaskPatch } from "../client.ts";
import { formatStatusRefusal } from "../digest.ts";
import { runTool, toolText } from "./reply.ts";
import { PRIORITIES, resolveTarget, safeText, TASK_TOOL_DESCRIPTIONS, type TaskDeps } from "./task.ts";

// Optional members carry an explicit `| undefined` — see the FleetArgs note in mcp/tools/fleet.ts.
export interface UpdateArgs {
  readonly boardId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly baseRev?: string | undefined;
  readonly status?: string | undefined;
  readonly priority?: (typeof PRIORITIES)[number] | null | undefined;
}

const BASE_REV_REFUSAL =
  'baseRev must be the 12-character hex value corral_task_read printed after "description rev:". If it printed "unavailable", this description cannot be rewritten through this tool — edit it in the corral UI.';

function descriptionRefusal(args: UpdateArgs): string | null {
  if (args.description === undefined) {
    return args.baseRev === undefined ? null : "baseRev is only meaningful with description — drop it, or pass the description you meant to write";
  }
  if (args.description.trim() === "") return "refusing a blank description — it would erase the card's task statement. Clearing a description is a corral UI action.";
  if (args.baseRev === undefined) return "a description rewrite needs baseRev: call corral_task_read on this card and pass the value it printed after \"description rev:\"";
  return DESCRIPTION_REV_RE.test(args.baseRev.trim()) ? null : BASE_REV_REFUSAL;
}

export function updateHandler(deps: TaskDeps, args: UpdateArgs): Promise<string> {
  return runTool(async () => {
    const own = await deps.identity.requireCard();
    const resolved = await resolveTarget(deps, args.boardId, args.taskId);
    if (resolved.kind === "error") return resolved.message;
    const target = resolved.kind === "card"
      ? resolved
      : { boardId: own.boardId, taskId: own.taskId, title: own.title, columns: own.columns };
    const crossCard = target.boardId !== own.boardId || target.taskId !== own.taskId;

    const refusal = descriptionRefusal(args);
    if (refusal !== null) return refusal;
    if (args.status !== undefined) {
      const column = target.columns.find((c) => c.id === args.status);
      // Compared raw (a real validation against the real column ids), firewalled for the reply by digest.ts.
      if (column === undefined) return formatStatusRefusal(args.status, target.columns.map((c) => c.id));
      if (crossCard && column.closed) {
        return `refusing to move ${target.boardId}/${target.taskId} ("${safeText(target.title)}") into closing column ${safeText(column.id)}: closing another card is the operator's move, not a session's`;
      }
    }

    const patch: TaskPatch = {
      ...(args.title === undefined ? {} : { title: args.title }),
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.baseRev === undefined ? {} : { baseRev: args.baseRev.trim() }),
      ...(args.status === undefined ? {} : { status: args.status }),
      ...(args.priority === undefined ? {} : { priority: args.priority }),
    };
    if (Object.keys(patch).length === 0) return "nothing to update — pass at least one of title, description, status, priority";
    let task: Awaited<ReturnType<TaskDeps["client"]["editTask"]>>;
    try {
      task = await deps.client.editTask({ boardId: target.boardId, taskId: target.taskId, patch });
    } catch (err) {
      if (err instanceof CorralError && err.code === "description_conflict") {
        return `not written: the card or its description changed since your read. Call corral_task_read on ${target.boardId}/${target.taskId} again, merge your change into what it returns, and retry with its new rev.`;
      }
      throw err;
    }
    const rev = args.description === undefined ? "" : ` — description rev: ${task.descriptionRev}`;
    return `updated ${target.boardId}/${target.taskId} ("${safeText(task.title)}"): status=${safeText(task.status)} priority=${task.priority ?? "none"}${rev}`;
  });
}

export function registerUpdateTool(server: McpServer, deps: TaskDeps): void {
  server.registerTool(
    "corral_task_update",
    {
      title: "Update a card",
      description: TASK_TOOL_DESCRIPTIONS.update,
      inputSchema: z.object({
        boardId: z.string().optional().describe("with taskId, update another card; omit both for this session's own card"),
        taskId: z.string().optional().describe("with boardId, update another card; a bare taskId is refused"),
        title: z.string().optional(),
        description: z.string().optional().describe(
          "OVERWRITES the whole field — read it with corral_task_read first and pass its rev as baseRev.",
        ),
        baseRev: z.string().optional().describe('required with description: the value corral_task_read printed after "description rev:"'),
        status: z.string().optional().describe("a column id of the target card's board; a wrong id is refused with the list"),
        priority: z.enum(PRIORITIES).nullable().optional().describe("null clears the priority"),
      }).strict(),
    },
    async (args: UpdateArgs) => toolText(await updateHandler(deps, args)),
  );
}
