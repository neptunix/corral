import type { SessionRow } from "@shared/schema";
import { describe, expect, it } from "vitest";

import { detectTransitions, type WorkingMap } from "../server/transition.ts";

const MIN = 600_000;
const row = (paneId: string, status: string): SessionRow => ({
  env: "e", paneId, status, agent: "claude", cwd: "/x", tab: "t-" + paneId, workspace: "w",
  sessionId: null, recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null,
});
const key = (p: string): string => `e:${p}`;

describe("detectTransitions", () => {
  it("working → blocked fires blocked", () => {
    const r = detectTransitions([row("1", "working")], [row("1", "blocked")], { [key("1")]: 0 }, 1000, MIN);
    expect(r.events).toEqual([{ key: key("1"), state: "blocked", since: 1000, row: row("1", "blocked") }]);
  });
  it("first observation as blocked fires blocked", () => {
    const r = detectTransitions([], [row("1", "blocked")], {}, 1000, MIN);
    expect(r.events.map((e) => e.state)).toEqual(["blocked"]);
  });
  it("short working → idle does NOT fire finished", () => {
    const w: WorkingMap = { [key("1")]: 900_000 };
    const r = detectTransitions([row("1", "working")], [row("1", "idle")], w, 1_000_000, MIN); // 100s < 10min
    expect(r.events).toEqual([]);
  });
  it("long working → done fires finished", () => {
    const w: WorkingMap = { [key("1")]: 0 };
    const r = detectTransitions([row("1", "working")], [row("1", "done")], w, MIN + 1, MIN);
    expect(r.events.map((e) => e.state)).toEqual(["finished"]);
  });
  it("session already working at startup is seeded now → no finish on immediate finish (restart-safety)", () => {
    // Realistic epochs: were the seed 0 (the bug), now−0 ≥ MIN would fire finished. Seeding `now` prevents it,
    // so the events assertion below — not just the working-map value — proves restart-safety.
    const NOW = 1_700_000_000_000;
    const t1 = detectTransitions([], [row("1", "working")], {}, NOW, MIN);
    expect(t1.working[key("1")]).toBe(NOW);
    const t2 = detectTransitions([row("1", "working")], [row("1", "done")], t1.working, NOW + 1000, MIN);
    expect(t2.events).toEqual([]); // now−NOW = 1000 < MIN; a seed of 0 would have fired
  });
  it("unrecognized status is inert and does not touch the working map", () => {
    const w: WorkingMap = { [key("1")]: 42 };
    const r = detectTransitions([row("1", "working")], [row("1", "COMPACTING")], w, 9_999_999, MIN);
    expect(r.events).toEqual([]);
    expect(r.working[key("1")]).toBe(42);
  });
  it("clears on re-working (record cleared, timer restarts)", () => {
    const r = detectTransitions([row("1", "blocked")], [row("1", "working")], {}, 7000, MIN);
    expect(r.clearedKeys).toEqual([key("1")]);
    expect(r.working[key("1")]).toBe(7000);
  });
  it("clears on disappear and drops the working-map key", () => {
    const r = detectTransitions([row("1", "working")], [], { [key("1")]: 0 }, 8000, MIN);
    expect(r.clearedKeys).toEqual([key("1")]);
    expect(key("1") in r.working).toBe(false);
  });
});
