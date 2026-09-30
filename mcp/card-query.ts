import type { BoardFrame, Priority, TaskFrame } from "../shared/board-schema.ts";
import { closedColumnIds, sortTasks } from "../shared/board-schema.ts";

// Matches corral_fleet's max-50 clamp; a listing has no caller-supplied limit, so the page size is fixed.
export const CARD_PAGE_LIMIT = 50;

// Optional members carry an explicit `| undefined` — see the FleetArgs note in mcp/tools/fleet.ts.
export interface CardFilter {
  readonly status?: string | undefined;
  readonly open?: boolean | undefined;
  readonly priority?: NonNullable<Priority> | undefined;
  readonly q?: string | undefined;
}

export interface CardPage {
  readonly tasks: readonly TaskFrame[];
  readonly matched: number;
  readonly offset: number;
  readonly limit: number;
}

/** Open cards before closed, each tier by priority then newest — a flat rendering of the board UI. */
export function pageCards(board: BoardFrame, filter: CardFilter, offset: number): CardPage {
  const closed = closedColumnIds(board.columns);
  const sorted = sortTasks(board.tasks);
  const tiered = [...sorted.filter((t) => !closed.has(t.status)), ...sorted.filter((t) => closed.has(t.status))];
  const q = filter.q?.toLowerCase();
  const selected = tiered.filter((t) =>
    (filter.status === undefined || t.status === filter.status)
    && (filter.open !== true || !closed.has(t.status))
    && (filter.priority === undefined || t.priority === filter.priority)
    && (q === undefined || t.title.toLowerCase().includes(q)));
  return { tasks: selected.slice(offset, offset + CARD_PAGE_LIMIT), matched: selected.length, offset, limit: CARD_PAGE_LIMIT };
}
