import type { BoardState, StreamFrame } from "@shared/board-schema";

/**
 * Which of the three board sources the view renders. Kept here, pure and tested, because the order is
 * the whole safety argument for the REST seed and a single `??` swap silently inverts it — there is no
 * component test runner in this repo to catch that (vitest runs in `node`).
 *
 * Freshest first: an optimistic / post-mutation override, then the live SSE frame, then the cold-start
 * seed fetched once per board from `GET /api/state?board=`.
 *
 * The load-bearing rule is the middle one: **once the stream has answered, its answer wins — even when
 * that answer is "this board is not there"**. A frame with no `board` key is exactly that: the server
 * emits the board-less shape when the board id no longer resolves (deleted while a client had it open).
 * Falling through to the seed in that case would pin a deleted board's last snapshot on screen forever,
 * with nothing saying it is stale. Returning null instead lands on the honest "Select a board" state.
 */
export function pickBoardState(
  override: BoardState | null,
  frame: StreamFrame | null,
  seed: BoardState | null,
): BoardState | null {
  if (override !== null) return override;
  if (frame !== null) return "board" in frame ? frame : null;
  return seed;
}

/**
 * Same precedence for the parts that ride BOTH frame shapes — attention, unassigned, envs, accounts.
 * No board-key test here: either shape carries them, so any frame supersedes the seed on its own.
 */
export function pickGlobalState(
  override: BoardState | null,
  frame: StreamFrame | null,
  seed: BoardState | null,
): StreamFrame | null {
  return override ?? frame ?? seed;
}
