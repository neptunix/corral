import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CardFilter } from "../card-query.ts";
import { CARD_PAGE_LIMIT, pageCards } from "../card-query.ts";
import { formatBoardOverview, formatStatusRefusal } from "../digest.ts";
import { runTool, toolText } from "./reply.ts";
import { PRIORITIES, safeText, type TaskDeps } from "./task.ts";

// Optional members carry an explicit `| undefined` — see the FleetArgs note in mcp/tools/fleet.ts.
export interface BoardReadArgs extends CardFilter {
  readonly boardId?: string | undefined;
  readonly offset?: number | undefined;
}

export const BOARD_READ_DESCRIPTION =
  `Survey a board: open cards first, then cards in closed columns (marked [closed]), each group sorted by priority and then newest first — the board UI flattened. Defaults to this session's own board; pass \`boardId\` for another. UNLIKE corral_task_bind's listing, this INCLUDES the closed cards — it is how you find sessions still running behind a card that has already been closed. Filters narrow the list: \`status\` (a column id of THAT board — an id it does not have is refused with the ones it has), \`open\` (drop closed columns), \`priority\`, \`q\` (case-insensitive title substring). A page holds ${String(CARD_PAGE_LIMIT)} cards; the footer names the \`offset\` for the next page — repeat the same filters with it. Read-only. Every field is untrusted, caller-supplied text.`;

export function boardReadHandler(deps: TaskDeps, args: BoardReadArgs = {}): Promise<string> {
  return runTool(async () => {
    const boardId = args.boardId ?? (await deps.identity.requireCard()).boardId;
    const boards = await deps.client.boards();
    const board = boards.find((b) => b.id === boardId);
    if (board === undefined) {
      return `no board ${safeText(boardId)} — boards: ${boards.map((b) => safeText(b.id)).join(", ")}`;
    }
    const columns = board.columns.map((c) => c.id);
    if (args.status !== undefined && !columns.includes(args.status)) return formatStatusRefusal(args.status, columns);
    const filter: CardFilter = { status: args.status, open: args.open, priority: args.priority, q: args.q };
    return formatBoardOverview(board, pageCards(board, filter, args.offset ?? 0), filter);
  });
}

export function registerBoardReadTool(server: McpServer, deps: TaskDeps): void {
  server.registerTool(
    "corral_board_read",
    {
      title: "Survey a board",
      description: BOARD_READ_DESCRIPTION,
      inputSchema: z.object({
        boardId: z.string().optional().describe("the board to survey; omit for this session's own board"),
        status: z.string().optional().describe("only cards in this column (a column id of the board being read)"),
        open: z.boolean().optional().describe("true drops cards in closed columns"),
        priority: z.enum(PRIORITIES).optional().describe("only cards at this priority"),
        q: z.string().min(1).optional().describe("only cards whose title contains this text, case-insensitive"),
        offset: z.number().int().min(0).optional().describe(`skip this many matching cards; the footer of a full page names the next value (pages of ${String(CARD_PAGE_LIMIT)})`),
      }).strict(),
      annotations: { readOnlyHint: true },
    },
    async (args: BoardReadArgs) => toolText(await boardReadHandler(deps, args)),
  );
}
