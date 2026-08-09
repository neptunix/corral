import type { BoardState, GlobalState } from "@shared/board-schema";
import { describe, expect, it } from "vitest";

import { pickBoardState, pickGlobalState } from "../web/src/lib/board-precedence.ts";

const global_: GlobalState = { unassigned: [], envs: {}, attention: {}, accounts: [] };
const board = (id: string): BoardState => ({
  ...global_, board: { id, label: id.toUpperCase(), columns: [], tasks: [], spawnPresets: [], defaultSpawnPresetId: null }, tasks: [],
});

const seed = board("seeded");
const live = board("live");
const override = board("override");

describe("pickBoardState", () => {
  it("shows the seed while the stream has produced nothing yet — the cold-start floor", () => {
    expect(pickBoardState(null, null, seed)).toBe(seed);
  });

  it("a live board frame supersedes the seed", () => {
    expect(pickBoardState(null, live, seed)).toBe(live);
  });

  it("an optimistic / post-mutation override beats both", () => {
    expect(pickBoardState(override, live, seed)).toBe(override);
  });

  it("a board-less frame means the board is gone, so it beats the seed with null — NOT a fallthrough", () => {
    // The server emits the board-less shape when the board id no longer resolves (deleted while a
    // client had it open). Falling through to the seed would pin the deleted board's last snapshot on
    // screen forever with no staleness signal; null lands on the honest "Select a board" state.
    expect(pickBoardState(null, global_, seed)).toBeNull();
    expect(pickBoardState(null, global_, null)).toBeNull();
  });

  it("has nothing to show when every source is empty", () => {
    expect(pickBoardState(null, null, null)).toBeNull();
  });
});

describe("pickGlobalState", () => {
  it("falls back to the seed only while no frame has arrived", () => {
    expect(pickGlobalState(null, null, seed)).toBe(seed);
    expect(pickGlobalState(null, global_, seed)).toBe(global_);
  });

  it("keeps a board-less frame — attention/unassigned/envs ride both shapes", () => {
    // Unlike pickBoardState this must NOT null out on a missing board key: the Unassigned view and the
    // attention rail are fed from exactly these frames.
    expect(pickGlobalState(null, global_, null)).toBe(global_);
  });

  it("an override beats both", () => {
    expect(pickGlobalState(override, global_, seed)).toBe(override);
  });
});
