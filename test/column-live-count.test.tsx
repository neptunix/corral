// @vitest-environment jsdom
import type { BoardFrame as BoardType, BoardState, EnrichedSessionLink, EnrichedTask } from "@shared/board-schema";
import { EMPTY_DIAGNOSTICS } from "@shared/diagnostics-schema";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Board } from "../web/src/components/Board";
import { worstTone } from "../web/src/lib/session-state";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void { /* layout is not under test */ }
    disconnect(): void { /* nothing observed */ }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

interface LiveOpts {
  readonly claudeStatus?: string | null;
  readonly detached?: boolean;
  /** Defaults to the link's own name — set it to make two links resolve to ONE session. */
  readonly pane?: string;
}

function makeLink(name: string, live: LiveOpts | null): EnrichedSessionLink {
  const pane = live?.pane ?? name;
  return {
    env: "e1", paneId: `p-${pane}`, tabId: "t", tabLabel: name, workspaceId: "w",
    workspaceLabel: "ws", name, cwdSnapshot: "/repo", sessionId: `s-${pane}`,
    live: live === null ? null : {
      status: "working",
      model: null, ctxPct: null,
      detached: live.detached ?? false,
      recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null,
      claudeStatus: live.claudeStatus === undefined ? "busy" : live.claudeStatus,
      claudeName: name, waitingFor: null, remoteControl: null, registryStatus: "ok",
    },
  };
}

function makeTask(id: string, status: string, sessions: readonly EnrichedSessionLink[]): EnrichedTask {
  return {
    id, title: `Task ${id}`, description: "", status, priority: null,
    sessions: [...sessions], createdAt: 0, updatedAt: 0, logCount: 0, noteCount: 0, lastLogAtMs: null,
  };
}

/** One open column ("Doing") and one closed column ("Closed"), which renders as a collapsed strip. */
function makeBoardState(tasks: readonly EnrichedTask[]): BoardState {
  const board: BoardType = {
    id: "b1", label: "Board one",
    columns: [{ id: "doing", label: "Doing" }, { id: "closed", label: "Closed", type: "closed" }],
    tasks: [], spawnPresets: [], defaultSpawnPresetId: null,
  };
  return {
    board, tasks: [...tasks], unassigned: [], envs: {}, attention: {}, accounts: [],
    diagnostics: EMPTY_DIAGNOSTICS,
  };
}

function renderBoard(tasks: readonly EnrichedTask[]): void {
  const boardState = makeBoardState(tasks);
  render(<Board boardState={boardState} boards={[boardState.board]}
    onOpenSession={vi.fn()} onMarkOptimistic={vi.fn()} onClearOptimistic={vi.fn()}
    onBoardStateChange={vi.fn()} pendingFixIssues={null} onFixIssuesConsumed={vi.fn()} />);
}

const marker = (column: string): HTMLElement | null => screen.queryByTestId(`live-count-${column}`);

describe("column live-session marker", () => {
  it("is absent when a column holds no live session", () => {
    renderBoard([
      makeTask("t1", "doing", [makeLink("a", null)]),
      makeTask("t2", "closed", []),
    ]);
    expect(marker("doing")).toBeNull();
    expect(marker("closed")).toBeNull();
  });

  it("counts live sessions across the column's cards, on the open column and the collapsed strip alike", () => {
    renderBoard([
      makeTask("t1", "doing", [makeLink("a", {}), makeLink("b", {})]),
      makeTask("t2", "doing", [makeLink("c", {})]),
      makeTask("t3", "closed", [makeLink("d", {})]),
    ]);
    expect(marker("doing")?.textContent).toBe("3");
    expect(marker("closed")?.textContent).toBe("1");
  });

  // A detached link is a card still pointing at a session that has ended — the pane is gone and
  // nothing is burning tokens behind the collapsed column. Counting it is the whole point of the
  // marker inverted: it would report work where there is none.
  it("does not count a detached link", () => {
    renderBoard([makeTask("t1", "closed", [makeLink("a", { detached: true }), makeLink("b", {})])]);
    expect(marker("closed")?.textContent).toBe("1");
  });

  // A spawn/attach race can persist two links for one session. The card collapses them before
  // rendering, so a marker that counted both would claim two sessions above a card showing one — and
  // a collapsed column shows only the marker, leaving nothing to reconcile it against.
  it("counts two links resolving to one session once, as the card renders them", () => {
    renderBoard([makeTask("t1", "closed", [makeLink("a", { pane: "x" }), makeLink("b", { pane: "x" })])]);
    expect(marker("closed")?.textContent).toBe("1");
  });

  // The marker answers "is anyone held up behind this column", so its colour must come from the most
  // urgent session inside, never from whichever card happens to sort first.
  it("takes its colour from the most urgent session, not the first one", () => {
    renderBoard([
      makeTask("t1", "closed", [makeLink("a", { claudeStatus: "idle" }), makeLink("b", { claudeStatus: "waiting" })]),
      makeTask("t2", "doing", [makeLink("c", { claudeStatus: "idle" }), makeLink("d", { claudeStatus: "busy" })]),
    ]);
    expect(marker("closed")?.className).toContain("red");
    expect(marker("doing")?.className).toContain("emerald");
    // The dot is a child of the marker and carries its own class, so the assertions above say nothing
    // about it — without this it could vanish, or paint one tone while the number paints another.
    expect(marker("closed")?.firstElementChild?.className).toContain("bg-red");
    expect(marker("doing")?.firstElementChild?.className).toContain("bg-emerald");
  });

  // The colour and the words must describe the SAME session. Picking the count's tone from the worst
  // session and the title's wording from the first one is a silent mismatch: the column reads red
  // while its tooltip says "idle", which strands anyone the colour alone does not reach.
  it("words the title for the session the colour came from, and pluralises the count", () => {
    renderBoard([
      makeTask("t1", "closed", [makeLink("a", { claudeStatus: "idle" }), makeLink("b", { claudeStatus: "waiting" })]),
    ]);
    expect(marker("closed")?.getAttribute("title")).toBe("2 live sessions · waiting");
  });

  // The strip's own count stays what it was — the marker is added beside it, not in its place, or a
  // full column with no live session reads as empty.
  it("keeps the collapsed strip's task count", () => {
    renderBoard([
      makeTask("t1", "closed", [makeLink("a", {})]),
      makeTask("t2", "closed", []),
    ]);
    expect(screen.getByTestId("task-count-closed").textContent).toBe("2");
  });

  it("says the count in words for a pointer, so the colour is never the only carrier", () => {
    renderBoard([makeTask("t1", "closed", [makeLink("a", { claudeStatus: "waiting" })])]);
    expect(marker("closed")?.getAttribute("title")).toBe("1 live session · waiting");
  });
});

describe("worstTone", () => {
  // The WHOLE order, pair by pair. Pinning only the top of it left the rest free to be reordered
  // silently — and ranking `unknown` up is enough to bury every waiting session under a quiet colour,
  // which is the one thing the marker exists to prevent.
  it.each([
    [["attention", "unavailable"], "attention"],
    [["unavailable", "working"], "unavailable"],
    [["working", "done"], "working"],
    [["done", "idle"], "done"],
    [["idle", "unknown"], "idle"],
    [["unknown", "attention"], "attention"],
    [["idle", "attention", "working", "done"], "attention"],
  ] as const)("ranks %j → %s", (tones, expected) => {
    expect(worstTone(tones)).toBe(expected);
    // Order of the group must not decide the answer.
    expect(worstTone([...tones].reverse())).toBe(expected);
  });

  it("falls back to the quiet tone on an empty list", () => {
    expect(worstTone([])).toBe("unknown");
  });
});

// The predicate this PR shares between the marker and the card also decides which session the card
// OPENS. Nothing else in the suite covers that call site: dropping the detached check there sends a
// click to a pane that no longer exists, and every other test stays green.
describe("the card's primary session — the same predicate", () => {
  const openOn = (sessions: readonly EnrichedSessionLink[]): ReturnType<typeof vi.fn> => {
    const onOpenSession = vi.fn();
    const boardState = makeBoardState([makeTask("t1", "doing", sessions)]);
    render(<Board boardState={boardState} boards={[boardState.board]}
      onOpenSession={onOpenSession} onMarkOptimistic={vi.fn()} onClearOptimistic={vi.fn()}
      onBoardStateChange={vi.fn()} pendingFixIssues={null} onFixIssuesConsumed={vi.fn()} />);
    fireEvent.click(screen.getByText("Task t1"));
    return onOpenSession;
  };

  it("opens the running session, not an ended one listed before it", () => {
    const onOpenSession = openOn([makeLink("dead", { detached: true }), makeLink("alive", {})]);
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession.mock.calls[0]?.[1]).toBe("p-alive");
  });

  it("opens nothing when the card has no session at all", () => {
    expect(openOn([])).not.toHaveBeenCalled();
  });
});
