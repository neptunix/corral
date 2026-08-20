// @vitest-environment jsdom
import type { Board as BoardType, BoardState, EnrichedTask, SpawnPreset, Task } from "@shared/board-schema";
import { EMPTY_DIAGNOSTICS } from "@shared/diagnostics-schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Board } from "../web/src/components/Board";
import { api } from "../web/src/lib/api";

beforeEach(() => {
  // dnd-kit's sensors measure layout via ResizeObserver, which jsdom does not implement.
  vi.stubGlobal("ResizeObserver", class {
    observe(): void { /* layout is not under test */ }
    disconnect(): void { /* nothing observed */ }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function makeBoard(overrides: Partial<BoardType> = {}): BoardType {
  return {
    id: "b1", label: "Board one",
    columns: [{ id: "c1", label: "To do" }],
    tasks: [], spawnPresets: [], defaultSpawnPresetId: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<EnrichedTask> = {}): EnrichedTask {
  return {
    id: "t_new1", title: "Fix 1 corral issue", description: "", status: "c1", priority: null,
    sessions: [], createdAt: 0, updatedAt: 0, ...overrides,
  };
}

function makeBoardState(overrides: Partial<BoardState> = {}): BoardState {
  return {
    board: makeBoard(), tasks: [], unassigned: [], envs: {}, attention: {}, accounts: [],
    diagnostics: EMPTY_DIAGNOSTICS, ...overrides,
  };
}

const preset = { id: "corral-doctor-fix", text: "/corral-doctor fix\n\nfix jq" };
const description = "corral found 1 issue to fix.";

/**
 * Mirrors what App.tsx actually does: a "Fix issues" click sets the request; onFixIssuesConsumed
 * REALLY nulls it, which really re-renders Board with a changed `pendingFixIssues` dep. A prior
 * version of this file passed inert `vi.fn()` for onFixIssuesConsumed — `pendingFixIssues` never
 * went null, the dependency never changed, and the effect's own cleanup never fired, so those tests
 * stayed green while the shipped effect's SELF-triggered re-render silently killed the success path
 * (the create landed, but the modal never opened). This is why the assertion is "the modal opens",
 * not "the callback was called" — the bug that mattered was invisible to the latter.
 */
function FixIssuesHost({ boardState, boards }: { readonly boardState: BoardState; readonly boards: readonly BoardType[] }) {
  const [pending, setPending] = useState<{ title: string; description: string; preset: SpawnPreset } | null>(null);
  const onBoardStateChange = useCallback(() => { /* not under test here */ }, []);
  const onFixIssuesConsumed = useCallback(() => { setPending(null); }, []);
  return (
    <>
      <button type="button" onClick={() => { setPending({ title: "Fix 1 corral issue", description, preset }); }}>
        Fix issues
      </button>
      <Board boardState={boardState} boards={boards} onOpenSession={vi.fn()} onMarkOptimistic={vi.fn()}
        onClearOptimistic={vi.fn()} onBoardStateChange={onBoardStateChange}
        pendingFixIssues={pending} onFixIssuesConsumed={onFixIssuesConsumed} />
    </>
  );
}

describe("Board — fix-issues task creation", () => {
  it("creates the ad-hoc task and opens it on Run Claude with the preset selected — with a REAL consuming callback", async () => {
    vi.spyOn(api.tasks, "create").mockResolvedValue(makeTask());
    const board = makeBoardState();

    render(<FixIssuesHost boardState={board} boards={[board.board]} />);
    fireEvent.click(screen.getByRole("button", { name: "Fix issues" }));

    expect(api.tasks.create).toHaveBeenCalledWith("b1", { title: "Fix 1 corral issue", description });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Run Claude/ }).getAttribute("aria-selected")).toBe("true");
    });
    const option = screen.getByRole("option", { name: "/corral-doctor fix" });
    expect((option as HTMLOptionElement).selected).toBe(true);
  });

  it("alerts on a failed create, with a real consuming callback", async () => {
    vi.spyOn(api.tasks, "create").mockRejectedValue(new Error("board full"));
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => { /* assert on the call, not the UI */ });
    const board = makeBoardState();

    render(<FixIssuesHost boardState={board} boards={[board.board]} />);
    fireEvent.click(screen.getByRole("button", { name: "Fix issues" }));

    await waitFor(() => { expect(alertSpy).toHaveBeenCalledTimes(1); });
    expect(alertSpy.mock.calls[0]?.[0]).toContain("board full");
    expect(screen.queryByRole("tab", { name: /Run Claude/ })).toBeNull();
  });

  // Regression: without the board-identity check, a create that resolves AFTER the operator has
  // switched boards would show board A's freshly-created task while Board is now rendering board B's
  // data — a task/board mismatch. The request is still made exactly once; only the modal must not
  // open under the wrong board.
  it("does not show the task under a different board than the one it was created for", async () => {
    let resolveCreate: ((t: Task) => void) | undefined;
    vi.spyOn(api.tasks, "create").mockReturnValue(new Promise<Task>((resolve) => { resolveCreate = resolve; }));
    const boardA = makeBoardState({ board: makeBoard({ id: "bA" }) });
    const boardB = makeBoardState({ board: makeBoard({ id: "bB" }) });

    const { rerender } = render(<FixIssuesHost boardState={boardA} boards={[boardA.board, boardB.board]} />);
    fireEvent.click(screen.getByRole("button", { name: "Fix issues" }));
    expect(api.tasks.create).toHaveBeenCalledWith("bA", expect.anything());

    // The operator switches to a different board while that create is still in flight.
    rerender(<FixIssuesHost boardState={boardB} boards={[boardA.board, boardB.board]} />);
    resolveCreate?.(makeTask());

    await new Promise((r) => { setTimeout(r, 0); }); // let the resolved promise's .then run
    expect(api.tasks.create).toHaveBeenCalledTimes(1); // still exactly one create — board A's
    expect(screen.queryByRole("tab", { name: /Run Claude/ })).toBeNull(); // not shown under board B
  });
});

describe("Board — TaskEditModal remounts on a task-identity swap", () => {
  // Regression: without `key={editingTask.id}`, React reused the mounted TaskEditModal instance when
  // the fix-issues task replaced an already-open one — its useState(task.x) initializers never re-ran,
  // so the modal kept showing the STALE task's tab/fields under the new task's id.
  it("shows the new task's Run tab, not the previously-open task's stale Task tab", async () => {
    const existingTask = makeTask({ id: "t_existing", title: "Existing task" });
    const boardState = makeBoardState({
      board: makeBoard({ tasks: [existingTask] }),
      tasks: [existingTask],
    });
    let resolveCreate: ((t: Task) => void) | undefined;
    vi.spyOn(api.tasks, "create").mockReturnValue(new Promise<Task>((resolve) => { resolveCreate = resolve; }));

    const { rerender } = render(<Board boardState={boardState} boards={[boardState.board]}
      onOpenSession={vi.fn()} onMarkOptimistic={vi.fn()} onClearOptimistic={vi.fn()}
      onBoardStateChange={vi.fn()} pendingFixIssues={null} onFixIssuesConsumed={vi.fn()} />);

    fireEvent.click(screen.getByTitle("Edit task"));
    expect(screen.getByRole("tab", { name: "Task" }).getAttribute("aria-selected")).toBe("true");

    // The fix-issues create resolves while that modal is still open.
    rerender(<Board boardState={boardState} boards={[boardState.board]}
      onOpenSession={vi.fn()} onMarkOptimistic={vi.fn()} onClearOptimistic={vi.fn()} onBoardStateChange={vi.fn()}
      pendingFixIssues={{ title: "Fix 1 corral issue", description, preset }} onFixIssuesConsumed={vi.fn()} />);
    resolveCreate?.(makeTask());

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Run Claude/ }).getAttribute("aria-selected")).toBe("true");
    });
    expect(screen.queryByDisplayValue("Existing task")).toBeNull();
  });
});
