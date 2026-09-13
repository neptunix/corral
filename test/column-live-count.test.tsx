// @vitest-environment jsdom
import type { BoardFrame as BoardType, BoardState, EnrichedSessionLink, EnrichedTask } from "@shared/board-schema";
import { EMPTY_DIAGNOSTICS } from "@shared/diagnostics-schema";
import { cleanup, render, screen } from "@testing-library/react";
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
  readonly status?: string;
  readonly detached?: boolean;
}

function makeLink(name: string, live: LiveOpts | null): EnrichedSessionLink {
  return {
    env: "e1", paneId: `p-${name}`, tabId: "t", tabLabel: name, workspaceId: "w",
    workspaceLabel: "ws", name, cwdSnapshot: "/repo", sessionId: `s-${name}`,
    live: live === null ? null : {
      status: live.status ?? "working",
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

  // The marker answers "is anyone held up behind this column", so its colour must come from the most
  // urgent session inside, never from whichever card happens to sort first.
  it("takes its colour from the most urgent session, not the first one", () => {
    renderBoard([
      makeTask("t1", "closed", [makeLink("a", { claudeStatus: "idle" }), makeLink("b", { claudeStatus: "waiting" })]),
      makeTask("t2", "doing", [makeLink("c", { claudeStatus: "idle" }), makeLink("d", { claudeStatus: "busy" })]),
    ]);
    expect(marker("closed")?.className).toContain("red");
    expect(marker("doing")?.className).toContain("emerald");
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
  it("ranks a session needing a human above every other state", () => {
    expect(worstTone(["idle", "attention", "working", "done"])).toBe("attention");
  });

  // `unavailable` means corral could not read the session's state. Ranking it below a calm tone would
  // hide it behind one, which is the exact failure the tone exists to prevent.
  it("ranks an unreadable session above a working one", () => {
    expect(worstTone(["working", "unavailable", "idle"])).toBe("unavailable");
  });

  it("falls back to the quiet tone on an empty list", () => {
    expect(worstTone([])).toBe("unknown");
  });
});
