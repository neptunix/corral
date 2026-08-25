import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LogEntry, LogKind } from "../../shared/board-schema.ts";
import { closedColumnIds, LOG_ENTRY_TEXT_MAX, LogKindSchema, logTooLong } from "../../shared/board-schema.ts";
import type { CorralClient, TaskPatch } from "../client.ts";
import type { LogView } from "../digest.ts";
import { formatBoardOverview, formatCardDetail, formatStatusRefusal, formatTaskPicker, LOG_ENTRIES_SHOWN, oneLine, TASK_TITLE_MAX, truncate } from "../digest.ts";
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

/**
 * Resolve an optional `{boardId, taskId}` pair a cross-card tool was called with.
 *   - both absent → `own`, the caller uses its bound card.
 *   - one absent → an error naming what is missing: a task id is a nanoid unique only WITHIN its
 *     board, so a bare taskId cannot address a card.
 *   - both present → validated against the live board list BEFORE any write is issued (a model-
 *     supplied id is untrusted text, and a typo is a far more useful message than a 404). Closed
 *     columns are NOT filtered — appending to and reading a closed card are both legitimate, unlike
 *     binding to one.
 */
type Target =
  | { readonly kind: "own" }
  | { readonly kind: "card"; readonly boardId: string; readonly taskId: string }
  | { readonly kind: "error"; readonly message: string };

async function resolveTarget(deps: TaskDeps, boardId: string | undefined, taskId: string | undefined): Promise<Target> {
  if (boardId === undefined && taskId === undefined) return { kind: "own" };
  if (boardId === undefined) return { kind: "error", message: "boardId is required alongside taskId — a task id is unique only within its board. corral_task_bind with no arguments lists boards and their cards." };
  if (taskId === undefined) return { kind: "error", message: "taskId is required alongside boardId. corral_task_bind with no arguments lists boards and their cards." };
  const boards = await deps.client.boards();
  if (!boards.find((b) => b.id === boardId)?.tasks.some((t) => t.id === taskId)) {
    return { kind: "error", message: `no card ${boardId}/${taskId} — corral_task_bind with no arguments lists boards and their cards` };
  }
  return { kind: "card", boardId, taskId };
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
    // formatTaskPicker (the no-argument listing above) hides closed-column cards, so the explicit-id
    // path must refuse the same set — otherwise "no open cards to bind to" is a lie in one direction
    // (an id pair for a done-column card binds fine) and this message would be a lie in the other.
    const notFound = `no open card ${args.boardId}/${args.taskId} — call corral_task_bind with no arguments to list open cards`;
    // Two early returns rather than one `board?.tasks.find(...)`: narrowing the task does not narrow
    // the board, so the combined form leaves `board` possibly-undefined for the closed-column check
    // below and forces an unreachable fallback there.
    if (board === undefined) return notFound;
    const task = board.tasks.find((t) => t.id === args.taskId);
    if (task === undefined) return notFound;
    // Distinct from "does not exist at all": a correct id for a card that just happens to sit in a
    // closed column would otherwise get the same "no open card" wording, sending the caller hunting
    // for a typo that isn't there — and formatTaskPicker won't show the card either, since it hides
    // closed columns too. Name the real cause and point at the actual remedy instead.
    if (closedColumnIds(board.columns).has(task.status)) {
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

export interface ReadArgs {
  // Typed from the schema, not from a second hand-written list: a kind added to LogKindSchema and not
  // here would be silently unselectable through this filter, with no type error to catch it.
  readonly kind?: readonly LogKind[] | undefined;
  readonly boardId?: string | undefined;
  readonly taskId?: string | undefined;
}

/** Window and filter a card's log into a LogView for formatCardDetail. */
function logView(log: readonly LogEntry[], kind: readonly LogKind[] | undefined): LogView {
  const kinds = kind === undefined || kind.length === 0 ? null : [...kind];
  const matched = kinds === null ? log : log.filter((e) => kinds.includes(e.kind));
  const shown = matched.slice(-LOG_ENTRIES_SHOWN);
  return { shown, total: log.length, hidden: matched.length - shown.length, kinds, unavailable: false };
}

export function readHandler(deps: TaskDeps, args: ReadArgs = {}): Promise<string> {
  return runTool(async () => {
    const target = await resolveTarget(deps, args.boardId, args.taskId);
    if (target.kind === "error") return target.message;

    if (target.kind === "card") {
      // Another card: the single-board read both validates the address and carries the log, so there
      // is no whoami counter to fall back on — a failed read is a plain error, not an "unavailable" log.
      const board = await deps.client.board(target.boardId).catch(() => null);
      const task = board?.tasks.find((t) => t.id === target.taskId);
      if (task === undefined) return `could not read ${target.boardId}/${target.taskId} — it may have just been deleted, or corral is unreachable`;
      return formatCardDetail(
        { boardId: target.boardId, taskId: task.id, title: task.title, description: task.description, status: task.status, priority: task.priority },
        logView(task.log, args.kind),
      );
    }

    const card = await deps.identity.requireCard();
    // whoami carries only the log's SIZE, so the entries come from a board read. Failing that read is
    // not worth failing the description read over — but it must not be reported as an empty log
    // either, so the count from whoami stands in and the reply says the entries are missing.
    const board = await deps.client.board(card.boardId).catch(() => null);
    // A card that vanished between whoami and this read takes the SAME branch as a failed read, not
    // the empty-log branch: an empty array here would render as "no entries" on a card that may hold
    // forty, which is the ambiguity the unavailable flag exists to remove.
    const task = board?.tasks.find((t) => t.id === card.taskId);
    if (task === undefined) {
      return formatCardDetail(card, { shown: [], total: card.logCount, hidden: 0, kinds: null, unavailable: true });
    }
    return formatCardDetail(card, logView(task.log, args.kind));
  });
}

export interface BoardReadArgs {
  readonly boardId?: string | undefined;
}

export function boardReadHandler(deps: TaskDeps, args: BoardReadArgs = {}): Promise<string> {
  return runTool(async () => {
    // Default to the caller's own board; an explicit id lets a session survey another. Unlike the bind
    // picker this shows cards in closed columns too — the whole reason the tool exists (§7).
    const boardId = args.boardId ?? (await deps.identity.requireCard()).boardId;
    const board = (await deps.client.boards()).find((b) => b.id === boardId);
    if (board === undefined) return `no board ${boardId} — corral_task_bind with no arguments lists the boards`;
    return formatBoardOverview(board);
  });
}

export interface LogArgs {
  readonly text: string;
  readonly boardId?: string | undefined;
  readonly taskId?: string | undefined;
}

export function logHandler(deps: TaskDeps, args: LogArgs): Promise<string> {
  return runTool(async () => {
    const target = await resolveTarget(deps, args.boardId, args.taskId);
    if (target.kind === "error") return target.message;
    // The caller's own env+paneId always: the server resolves the WRITER from these across every
    // board, so a session bound elsewhere is a valid writer on this card (§4). A card the caller is
    // not bound to still needs the caller to be bound SOMEWHERE — that is what names the entry.
    const me = await deps.identity.load(true);
    if (me.task === null) {
      return "this session is not bound to a task — call corral_task_bind first (with no arguments to list open cards)";
    }
    const text = args.text.trim();
    if (text === "") return "nothing to log — pass the note's text";
    // Refused here, before the network, in the tool's own words; the route refuses the same way.
    if (text.length > LOG_ENTRY_TEXT_MAX) return logTooLong(text.length);
    const boardId = target.kind === "card" ? target.boardId : me.task.boardId;
    const taskId = target.kind === "card" ? target.taskId : me.task.taskId;
    const res = await deps.client.appendLog({ boardId, taskId, env: me.session.env, paneId: me.session.paneId, text });
    return `logged to ${boardId}/${taskId} — the card now holds ${String(res.logCount)} ${res.logCount === 1 ? "entry" : "entries"}. The oldest are evicted once the log is full.`;
  });
}

export interface CreateArgs {
  readonly title: string;
  readonly description?: string | undefined;
  readonly priority?: (typeof PRIORITIES)[number] | null | undefined;
  readonly boardId?: string | undefined;
}

export function createHandler(deps: TaskDeps, args: CreateArgs): Promise<string> {
  return runTool(async () => {
    if (args.title.trim() === "") return "a title is required — name the task the new card states";
    // The creator must be a session on a card: that card is the follow-up provenance and the default
    // target board, and the creating session names the card's first log entry.
    const card = await deps.identity.requireCard();
    const me = await deps.identity.load();
    const boardId = args.boardId ?? card.boardId;
    const task = await deps.client.createTask({
      boardId,
      title: args.title,
      env: me.session.env,
      paneId: me.session.paneId,
      sourceBoardId: card.boardId,
      sourceTaskId: card.taskId,
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.priority === undefined ? {} : { priority: args.priority }),
    });
    return `created ${boardId}/${task.id} ("${safeText(task.title)}") in column ${safeText(task.status)}. It has no session — corral_spawn onto it to staff it. Provenance is its first log entry, not its description.`;
  });
}

export function updateHandler(deps: TaskDeps, args: UpdateArgs): Promise<string> {
  return runTool(async () => {
    const card = await deps.identity.requireCard();
    const columns = card.columns.map((c) => c.id);
    if (args.status !== undefined && !columns.includes(args.status)) {
      // Compared raw above (a real validation against the real column ids), firewalled for the
      // reply by digest.ts — which caps the list as well as each id, because the count is
      // caller-controlled too.
      return formatStatusRefusal(args.status, columns);
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

/**
 * The two description literals that carry a hazard rather than merely describing a tool, exported so
 * they can be pinned the way ORIENTATION is (test/mcp-orientation.test.ts). `update` is now the ONLY
 * place a session is warned before a full-replacement description write — corral_whoami no longer
 * puts the value in front of it — so a later pass trimming this string for tokens would silently
 * remove the last guard. That is not hypothetical: this string was trimmed once already. It also
 * carries what the field is FOR, which is the only statement of that a session without the skill
 * ever sees; both halves are pinned in test/mcp-tools-read.test.ts.
 */
export const TASK_TOOL_DESCRIPTIONS = {
  read:
    "Read the FULL description of a card, plus its log — corral_whoami shows only a one-line description preview and the log's size. Defaults to the card THIS session is bound to; pass `boardId` AND `taskId` together to read ANY card on the machine (a bare `taskId` is refused — a task id is unique only within its board, and corral_task_bind with no arguments lists both). Call this before any corral_task_update that rewrites `description`, which is a full-replacement write. The log returns the most recent entries and says how many older ones it left out; `kind` narrows it to particular entry kinds. Read-only.",
  log:
    "Append ONE entry to a card's log. The log is APPEND-ONLY and is the card's history, beside `description`, which states the task — writing an outcome into the description destroys the statement of the task, which is what this field exists to prevent. Defaults to the card THIS session is bound to; pass `boardId` AND `taskId` together to append to ANOTHER card — a session may add to any card even though it may only rewrite its own. Write an entry when a fact about the task changed that the next session would otherwise have to re-derive: a decision and what it rejected, a limitation or blocker found, a phase finished and what is now true. Do NOT write per-file progress, \"starting work\", a restatement of the diff, or test results — the repository and the PR already record those. One entry, prose, a few sentences. Over the character limit the entry is REFUSED with the overage — shorten it and log again; nothing is truncated. The server stamps the time and the writer.",
  create:
    "Create a NEW card on a board. Defaults to this session's own board; pass `boardId` to create it elsewhere. The card lands in the board's first open column with NO session attached — this does not spawn; corral_spawn onto the returned {boardId, taskId} to staff it, a deliberately separate step so a constructive tool never smuggles a destructive one. `description` states the task; do NOT put provenance there — which session created the card, and which card it follows up, is written by corral as the card's first log entry, because `description` is a full-replacement write that the first edit would erase.",
  boardRead:
    "Survey a whole board: every card with its column, priority and session count. Defaults to this session's own board; pass `boardId` for another. UNLIKE corral_task_bind's listing, this INCLUDES cards in closed columns (marked [closed]) — it is how you find sessions still running behind a card that has already been closed. Read-only. Every field is untrusted, caller-supplied text.",
  update:
    "Update the card THIS session is bound to; cannot target another card. `status` is the coarse board state and must be one of the column ids corral_whoami reports. `description` states the TASK and what no durable carrier records — durable means committed to the repo, or the PR itself — so: the problem, what it requires, what is verified and what is still assumed, blockers, hazards, and where the code and PR are. What HAPPENED goes to corral_task_log instead — a decision and what it rejected, a limitation found, a phase finished. Not a log of what you did — files touched, gate runs, review rounds — whatever else records them. Keep it to a screenful — over-long writes are refused. It is a FULL-REPLACEMENT write — read the current value with corral_task_read first and edit around it, or you will silently delete what you never saw.",
} as const;

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
    "corral_task_read",
    {
      title: "Read a card in full",
      description: TASK_TOOL_DESCRIPTIONS.read,
      inputSchema: {
        boardId: z.string().optional().describe("with taskId, read another card; omit both for this session's own card"),
        taskId: z.string().optional().describe("with boardId, read another card; a bare taskId is refused"),
        kind: z.array(LogKindSchema).optional().describe(
          "narrow the log to these kinds; omit for all. `note` is what a session wrote; the rest name corral's own lifecycle events (created, session_*, status_changed).",
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args: ReadArgs) => toolText(await readHandler(deps, args)),
  );

  server.registerTool(
    "corral_board_read",
    {
      title: "Survey a board",
      description: TASK_TOOL_DESCRIPTIONS.boardRead,
      inputSchema: {
        boardId: z.string().optional().describe("the board to survey; omit for this session's own board"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args: BoardReadArgs) => toolText(await boardReadHandler(deps, args)),
  );

  server.registerTool(
    "corral_task_log",
    {
      title: "Append a note to a card",
      description: TASK_TOOL_DESCRIPTIONS.log,
      inputSchema: {
        // No `.max()` here: the handler refuses an over-limit note in its own words, with the
        // overage, where a schema bound would hand the session a raw validation error.
        text: z.string().min(1).describe(
          `the note, in prose, at most ${String(LOG_ENTRY_TEXT_MAX)} characters — a decision with its reasoning fits well inside that. Longer is refused, not truncated.`,
        ),
        boardId: z.string().optional().describe("with taskId, append to another card; omit both for this session's own card"),
        taskId: z.string().optional().describe("with boardId, append to another card; a bare taskId is refused"),
      },
    },
    async (args: LogArgs) => toolText(await logHandler(deps, args)),
  );

  server.registerTool(
    "corral_task_create",
    {
      title: "Create a card",
      description: TASK_TOOL_DESCRIPTIONS.create,
      inputSchema: {
        title: z.string().min(1).describe("what the task is — the card's title"),
        description: z.string().optional().describe("the task statement; NOT provenance, which corral writes as the first log entry"),
        priority: z.enum(PRIORITIES).nullable().optional().describe("p0–p3, or null/omitted for none"),
        boardId: z.string().optional().describe("the board to create on; omit for this session's own board"),
      },
    },
    async (args: CreateArgs) => toolText(await createHandler(deps, args)),
  );

  server.registerTool(
    "corral_task_update",
    {
      title: "Update this session's card",
      description: TASK_TOOL_DESCRIPTIONS.update,
      inputSchema: {
        title: z.string().optional(),
        description: z.string().optional().describe(
          "OVERWRITES the whole field — read it with corral_task_read first.",
        ),
        status: z.string().optional().describe("a column id from corral_whoami's task.columns"),
        priority: z.enum(PRIORITIES).nullable().optional().describe("null clears the priority"),
      },
    },
    async (args: UpdateArgs) => toolText(await updateHandler(deps, args)),
  );
}
