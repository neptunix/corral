// @vitest-environment jsdom
import type { BoardFrame as BoardType, BoardState, EnrichedSessionLink, EnrichedTask } from "@shared/board-schema";
import { EMPTY_DIAGNOSTICS } from "@shared/diagnostics-schema";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Board } from "../web/src/components/Board";
import { ApiError, api } from "../web/src/lib/api";

beforeEach(() => {
  // dnd-kit's sensors measure layout via ResizeObserver, which jsdom does not implement.
  vi.stubGlobal("ResizeObserver", class {
    observe(): void { /* layout is not under test */ }
    disconnect(): void { /* nothing observed */ }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const BOARD: BoardType = {
  id: "b1", label: "Board one",
  columns: [
    { id: "c1", label: "To do" },
    { id: "c2", label: "Doing" },
    { id: "cdone", label: "Done", type: "closed" },
  ],
  tasks: [], spawnPresets: [], defaultSpawnPresetId: null,
};

const LIVE = {
  status: "idle", model: null, ctxPct: null, detached: false, recap: null, recapAt: null,
  recapStatus: null, recapSource: null, statusline: null, claudeStatus: null, claudeName: null,
  waitingFor: null, remoteControl: null, registryStatus: null,
};

function link(overrides: Partial<EnrichedSessionLink> = {}): EnrichedSessionLink {
  return {
    env: "work-local", paneId: "w1:p0", tabId: "t1", tabLabel: "card-a", workspaceId: "w1",
    workspaceLabel: "corral", name: "card-a", cwdSnapshot: "/repo",
    sessionId: "551754cc-ee7b-4b9f-a6a8-aa599f6eb6e3",
    live: LIVE,
    ...overrides,
  };
}

function makeTask(overrides: Partial<EnrichedTask> = {}): EnrichedTask {
  return {
    id: "t1", title: "Refactor the API", description: "", status: "c1", priority: null,
    sessions: [], createdAt: 0, updatedAt: 0, logCount: 0, lastLogAt: null, ...overrides,
  };
}

function renderWith(task: EnrichedTask): void {
  const boardState: BoardState = {
    board: { ...BOARD, tasks: [task] }, tasks: [task], unassigned: [], envs: {}, attention: {},
    accounts: [], diagnostics: EMPTY_DIAGNOSTICS,
  };
  render(<Board boardState={boardState} boards={[boardState.board]} onOpenSession={vi.fn()}
    onMarkOptimistic={vi.fn()} onClearOptimistic={vi.fn()} onBoardStateChange={vi.fn()}
    pendingFixIssues={null} onFixIssuesConsumed={vi.fn()} />);
}

// Drives the column change through TaskEditModal. The drag-and-drop path is a SEPARATE call site
// with its own guards and is not covered here — dnd-kit's sensors need layout jsdom does not provide.
async function moveTo(fromLabel: string, toId: string): Promise<void> {
  fireEvent.click(screen.getByTitle("Edit task"));
  fireEvent.change(screen.getByDisplayValue(fromLabel), { target: { value: toId } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  // Only flush the save's microtasks — a move-only submit writes NOTHING, so waiting on `update`
  // would hang for the very case most of these tests exercise.
  await act(async () => { await Promise.resolve(); });
}

// A card landing in a closed column is the operator saying the work is over. Nothing closes the
// sessions still running on it, so they linger as orphan panes — this offer is what asks.
describe("Board — confirming a move into a closed column while sessions are live", () => {
  it("asks BEFORE writing the move, and cancelling leaves the card where it was", async () => {
    const task = makeTask({ sessions: [link()] });
    const update = vi.spyOn(api.tasks, "update").mockResolvedValue({ ...task, sessions: [], log: [] });
    const close = vi.spyOn(api.tasks, "close").mockResolvedValue({ ok: true });

    renderWith(task);
    await moveTo("To do", "cdone");

    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));

    await waitFor(() => { expect(screen.queryByText(/^Move to .+\?$/)).toBeNull(); });
    expect(update).not.toHaveBeenCalledWith("b1", "t1", expect.objectContaining({ status: "cdone" }));
    expect(close).not.toHaveBeenCalled();
  });

  it("writes the move and leaves the sessions alone on \"Move only\"", async () => {
    const task = makeTask({ sessions: [link()] });
    const update = vi.spyOn(api.tasks, "update").mockResolvedValue({ ...task, sessions: [], log: [] });
    const close = vi.spyOn(api.tasks, "close").mockResolvedValue({ ok: true });

    renderWith(task);
    await moveTo("To do", "cdone");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Move only" }));

    await waitFor(() => { expect(update).toHaveBeenCalledWith("b1", "t1", { status: "cdone" }); });
    expect(close).not.toHaveBeenCalled();
  });

  it("writes the move and then closes every live session on confirm", async () => {
    const task = makeTask({ sessions: [link(), link({ paneId: "w1:p1", name: "card-b", sessionId: null })] });
    vi.spyOn(api.tasks, "update").mockResolvedValue({ ...task, status: "cdone", sessions: [], log: [] });
    const close = vi.spyOn(api.tasks, "close").mockResolvedValue({ ok: true });

    renderWith(task);
    await moveTo("To do", "cdone");

    // Names the column the card is headed for — a board can define several closed ones, and
    // "Tracking" asks a different question from "Done".
    expect(await screen.findByText("Move to Done?")).toBeTruthy();
    expect(screen.getByText("2 sessions on this card are still running.")).toBeTruthy();
    expect(screen.getByText("card-a")).toBeTruthy();
    expect(screen.getByText("card-b")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Move and close 2 sessions" }));
    await waitFor(() => { expect(close).toHaveBeenCalledTimes(2); });
    // The move goes first: closing the sessions of a card that never moved is the one outcome
    // nobody asked for.
    expect(api.tasks.update).toHaveBeenCalledWith("b1", "t1", { status: "cdone" });
    expect(close).toHaveBeenNthCalledWith(1, "b1", "t1", "work-local", "w1:p0", "551754cc-ee7b-4b9f-a6a8-aa599f6eb6e3");
    expect(close).toHaveBeenNthCalledWith(2, "b1", "t1", "work-local", "w1:p1", null);
  });

  // A detached link is a session that already ended. Without this filter every card drifting into an
  // archive or a tracking strip would ask a question with nothing behind it. The server ALWAYS sends
  // a `live` object for a task-attached link — a detached one carries `detached: true`, not null —
  // so `detached` is the branch that has to hold, and this fixture is what proves it does.
  it("stays silent when the card's only session is already detached", async () => {
    const task = makeTask({ sessions: [link({ live: { ...LIVE, status: "unknown", detached: true } })] });
    vi.spyOn(api.tasks, "update").mockResolvedValue({ ...task, status: "cdone", sessions: [], log: [] });

    renderWith(task);
    await moveTo("To do", "cdone");

    // Keyed on this dialog's own heading: TaskEditModal is a `dialog` too, and on a refused save it
    // is still open, so a role query would pass or fail for the wrong reason.
    expect(screen.queryByText(/^Move to .+\?$/)).toBeNull();
  });

  // The card's other fields are still saved before the question is asked. A refusal there leaves the
  // card in an unknown state, and asking about its sessions on top would compound it.
  it("stays silent when the server refuses the fields saved alongside the move", async () => {
    const task = makeTask({ title: "Old title", sessions: [link()] });
    vi.spyOn(api.tasks, "update").mockRejectedValue(new Error("not_found"));

    renderWith(task);
    fireEvent.click(screen.getByTitle("Edit task"));
    fireEvent.change(screen.getByDisplayValue("Old title"), { target: { value: "New title" } });
    fireEvent.change(screen.getByDisplayValue("To do"), { target: { value: "cdone" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => { expect(api.tasks.update).toHaveBeenCalled(); });
    // Keyed on this dialog's own heading: TaskEditModal is a `dialog` too, and on a refused save it
    // is still open, so a role query would pass or fail for the wrong reason.
    expect(screen.queryByText(/^Move to .+\?$/)).toBeNull();
  });

  // Sessions killed for a card that never moved is the one outcome nobody asked for, so a failed
  // move must stop before the first close — and stay cancellable, because nothing happened.
  it("does not touch the sessions when the move itself fails", async () => {
    const task = makeTask({ sessions: [link()] });
    const update = vi.spyOn(api.tasks, "update").mockRejectedValueOnce(new Error("conflict"));
    const close = vi.spyOn(api.tasks, "close").mockResolvedValue({ ok: true });

    renderWith(task);
    await moveTo("To do", "cdone");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Move and close 1 session" }));

    expect(await screen.findByText(/Done: conflict/)).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
    const offer = within(screen.getByRole("dialog"));
    expect(offer.getByText("Move to Done?")).toBeTruthy();       // still offering the move, not past it
    expect(offer.getByRole("button", { name: "Cancel" })).not.toHaveProperty("disabled", true);

    update.mockResolvedValueOnce({ ...task, status: "cdone", sessions: [], log: [] });
    fireEvent.click(offer.getByRole("button", { name: "Move and close 1 session" }));
    await waitFor(() => { expect(close).toHaveBeenCalledTimes(1); });
  });

  // The edit modal submits every field, so without the "did the status actually change" guard every
  // title edit on a card already sitting in Done would ask about its sessions again.
  it("does not ask when a card already in the closed column is merely renamed", async () => {
    const task = makeTask({ status: "cdone", title: "Old title", sessions: [link()] });
    const update = vi.spyOn(api.tasks, "update").mockResolvedValue({ ...task, sessions: [], log: [] });

    renderWith(task);
    // A closed column renders as a collapsed strip; expand it to reach the card.
    fireEvent.click(screen.getByTitle(/^Show Done/));
    fireEvent.click(screen.getByTitle("Edit task"));
    fireEvent.change(screen.getByDisplayValue("Old title"), { target: { value: "New title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => { expect(update).toHaveBeenCalled(); });
    expect(screen.queryByText(/^Move to .+\?$/)).toBeNull();
    expect(update).toHaveBeenCalledWith("b1", "t1", expect.objectContaining({ title: "New title", status: "cdone" }));
  });

  // Cancelling must leave the card untouched — and a card is touched by any write, because the PATCH
  // route stamps `updatedAt` unconditionally. So a move-only submit holds back the WHOLE request.
  it("writes nothing at all when the move is the only change", async () => {
    const task = makeTask({ sessions: [link()] });
    const update = vi.spyOn(api.tasks, "update").mockResolvedValue({ ...task, sessions: [], log: [] });

    renderWith(task);
    await moveTo("To do", "cdone");

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  // A close is a pane kill: it cannot be undone, and the server answers a second attempt on a dead
  // pane with 404. Retrying the whole list would therefore fail on the row that already succeeded and
  // never reach the one still running — so the offer keeps only what is still open.
  it("keeps only the sessions that failed, and retries just those", async () => {
    const task = makeTask({ sessions: [link(), link({ paneId: "w1:p1", name: "card-b", sessionId: null })] });
    vi.spyOn(api.tasks, "update").mockResolvedValue({ ...task, status: "cdone", sessions: [], log: [] });
    const close = vi.spyOn(api.tasks, "close")
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("ssh: connect timed out"));

    renderWith(task);
    await moveTo("To do", "cdone");
    fireEvent.click(await screen.findByRole("button", { name: "Move and close 2 sessions" }));

    // The failure names the row it belongs to, and the closed one is gone from the list.
    expect(await screen.findByText(/card-b: ssh: connect timed out/)).toBeTruthy();
    const offer = within(screen.getByRole("dialog"));
    // The move is written by now, so the dialog stops offering it — only the remainder is on the table.
    expect(offer.getByText("Moved to Done")).toBeTruthy();
    expect(offer.queryByText("card-a")).toBeNull();

    close.mockResolvedValueOnce({ ok: true });
    fireEvent.click(offer.getByRole("button", { name: "Close 1 session" }));
    await waitFor(() => { expect(close).toHaveBeenCalledTimes(3); });
    expect(close).toHaveBeenNthCalledWith(3, "b1", "t1", "work-local", "w1:p1", null);
  });

  // The board's liveness is up to one poll old, and a session can also be closed from the terminal or
  // another tab. Asking to close what is already gone got what it asked for — reporting a failure for
  // that turned an ordinary sequence (close the session, then file the card) into a red error.
  it("treats an already-dead pane as closed, not as a failure", async () => {
    const task = makeTask({ sessions: [link()] });
    vi.spyOn(api.tasks, "update").mockResolvedValue({ ...task, status: "cdone", sessions: [], log: [] });
    vi.spyOn(api.tasks, "close").mockRejectedValue(new ApiError("pane is not live — nothing to close", "no_live_pane"));

    renderWith(task);
    await moveTo("To do", "cdone");
    await screen.findByRole("dialog");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move and close 1 session" }));

    await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
    expect(screen.queryByText(/nothing to close/)).toBeNull();
  });

  // The opposite case, and the reason the check is on the code rather than on "a close that failed":
  // this pane is running someone ELSE's session now, so killing it would be the real damage.
  it("still reports a refusal about a different session", async () => {
    const task = makeTask({ sessions: [link()] });
    vi.spyOn(api.tasks, "update").mockResolvedValue({ ...task, status: "cdone", sessions: [], log: [] });
    vi.spyOn(api.tasks, "close").mockRejectedValue(new ApiError("pane now belongs to a different session", "pane_reused"));

    renderWith(task);
    await moveTo("To do", "cdone");
    await screen.findByRole("dialog");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move and close 1 session" }));

    expect(await screen.findByText(/card-a: pane now belongs to a different session/)).toBeTruthy();
  });

  it("stays silent on a move between open columns", async () => {
    const task = makeTask({ sessions: [link()] });
    vi.spyOn(api.tasks, "update").mockResolvedValue({ ...task, status: "c2", sessions: [], log: [] });

    renderWith(task);
    await moveTo("To do", "c2");

    // Keyed on this dialog's own heading: TaskEditModal is a `dialog` too, and on a refused save it
    // is still open, so a role query would pass or fail for the wrong reason.
    expect(screen.queryByText(/^Move to .+\?$/)).toBeNull();
  });
});
