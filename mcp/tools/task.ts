import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { closedColumnIds } from "../../shared/board-schema.ts";
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

/** A card title, its status, or a column id is caller-supplied free text — any session on the
 * board can set a title/status via corral_task_update, and column ids are an unconstrained
 * z.string() settable via the API's PatchBoardBodySchema. Echoing any of them into a
 * confirmation/refusal string must go through the same firewall mcp/digest.ts applies to every
 * rendered field, or one session can smuggle an unbounded, newline-carrying string into another
 * session's tool output. One idiom for all three rather than a per-field one-off. */
function safeText(text: string): string {
  return truncate(oneLine(text), TASK_TITLE_MAX);
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
      return `this session is already bound to ${me.task.boardId}/${me.task.taskId} ("${safeText(me.task.title)}"). Rebinding is not available; detach from the corral UI first if that is what you want.`;
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
    // formatTaskPicker (the no-argument listing above) hides closed-column cards, so the explicit-id
    // path must refuse the same set — otherwise "no open cards to bind to" is a lie in one direction
    // (an id pair for a done-column card binds fine) and this message would be a lie in the other.
    if (task === undefined) {
      return `no open card ${args.boardId}/${args.taskId} — call corral_task_bind with no arguments to list open cards`;
    }
    // Distinct from "does not exist at all": a correct id for a card that just happens to sit in a
    // closed column would otherwise get the same "no open card" wording, sending the caller hunting
    // for a typo that isn't there — and formatTaskPicker won't show the card either, since it hides
    // closed columns too. Name the real cause and point at the actual remedy instead.
    // (`board` is guaranteed defined here — `task` only resolves via `board?.tasks.find` above — the
    // fallback is for the type checker, not reachable in practice.)
    const closed = board === undefined ? new Set<string>() : closedColumnIds(board.columns);
    if (closed.has(task.status)) {
      return `${args.boardId}/${args.taskId} is in a closed column; reopen it from the corral UI first`;
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
      // args.status and each column id are compared raw above (a real validation against the real
      // column ids), but firewalled here — this text is what gets echoed back into the reply.
      return `"${safeText(args.status)}" is not a column on this board. Valid status values: ${columns.map(safeText).join(", ")}`;
    }
    const patch: TaskPatch = {
      ...(args.title === undefined ? {} : { title: args.title }),
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.status === undefined ? {} : { status: args.status }),
      ...(args.priority === undefined ? {} : { priority: args.priority }),
    };
    if (Object.keys(patch).length === 0) return "nothing to update — pass at least one of title, description, status, priority";
    const task = await deps.client.patchTask({ boardId: card.boardId, taskId: card.taskId, patch });
    return `updated ${card.boardId}/${card.taskId}: status=${safeText(task.status)} priority=${task.priority ?? "none"} title="${safeText(task.title)}"`;
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
        "Update the card THIS session is bound to. Use `status` for the coarse board state (it must be one of the column ids corral_whoami reports) and `description` as the running progress log. Cannot target another card — there is no task id argument. WARNING: `description` is a full-replacement write, but corral_whoami — the only way this tool surfaces the current value back to a session — renders it bounded (at most 60 lines, 300 chars each); if corral_whoami showed a 'TRUNCATED' description, replacing it wholesale from that view WILL silently delete content you never saw. Append to or edit around what you can see, or accept the loss deliberately — do not round-trip a truncated view as if it were complete.",
      inputSchema: {
        title: z.string().optional(),
        description: z.string().optional().describe(
          "full replacement body; the progress log lives here. This OVERWRITES the whole field — corral_whoami's rendering of it is bounded and may be truncated, so a blind read-then-write can destroy content outside what was shown.",
        ),
        status: z.string().optional().describe("a column id from corral_whoami's task.columns"),
        priority: z.enum(PRIORITIES).nullable().optional().describe("null clears the priority"),
      },
    },
    async (args: UpdateArgs) => toolText(await updateHandler(deps, args)),
  );
}
