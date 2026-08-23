// @vitest-environment jsdom
import type { BoardFrame, EnrichedTask } from "@shared/board-schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskEditModal } from "../web/src/components/TaskEditModal";

afterEach(cleanup);

function makeBoard(overrides: Partial<BoardFrame> = {}): BoardFrame {
  return {
    id: "b1",
    label: "Board one",
    columns: [{ id: "c1", label: "To do" }, { id: "c2", label: "Done", type: "closed" }],
    tasks: [],
    spawnPresets: [],
    defaultSpawnPresetId: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<EnrichedTask> = {}): EnrichedTask {
  return {
    id: "t_abc1234",
    title: "Original title",
    description: "",
    status: "c1",
    priority: null,
    sessions: [],
    createdAt: 0,
    updatedAt: 0,
    logCount: 0,
    lastLogAtMs: null,
    ...overrides,
  };
}

const baseProps = {
  envs: [],
  onSpawn: vi.fn(),
  onOpenSession: vi.fn(),
  onMove: vi.fn(),
};

describe("TaskEditModal — save error channel", () => {
  it("a save refused by the server keeps the modal open, shows the server's message, and keeps the user's edits", async () => {
    const board = makeBoard();
    const task = makeTask();
    const onSave = vi.fn(() => Promise.reject(new Error("Boards service unavailable")));
    const onClose = vi.fn();
    render(<TaskEditModal task={task} board={board} {...baseProps} onSave={onSave} onDelete={vi.fn()} boards={[board]} onClose={onClose} />);

    fireEvent.change(screen.getByDisplayValue("Original title"), { target: { value: "Edited title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => { expect(screen.getByText("Boards service unavailable")).toBeDefined(); });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Edited title")).toBeDefined();
  });

  it("a successful save closes the modal only after the caller's onSave promise resolves", async () => {
    const board = makeBoard();
    const task = makeTask();
    const order: string[] = [];
    const onSave = vi.fn(() => Promise.resolve().then(() => { order.push("refresh"); }));
    const onClose = vi.fn(() => { order.push("close"); });
    render(<TaskEditModal task={task} board={board} {...baseProps} onSave={onSave} onDelete={vi.fn()} boards={[board]} onClose={onClose} />);

    // Save only accepts a click once something changed — see the dirty-gate describe below.
    fireEvent.change(screen.getByDisplayValue("Original title"), { target: { value: "Edited title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });
    expect(order).toEqual(["refresh", "close"]);
  });

  it("disables the Save button while the save is in flight", () => {
    const board = makeBoard();
    const task = makeTask();
    const onSave = vi.fn(() => new Promise<void>(() => { /* never settles for this assertion */ }));
    render(<TaskEditModal task={task} board={board} {...baseProps} onSave={onSave} onDelete={vi.fn()} boards={[board]} onClose={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue("Original title"), { target: { value: "Edited title" } });
    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(saveButton);
    expect(saveButton.hasAttribute("disabled")).toBe(true);
  });
});

describe("TaskEditModal — delete task", () => {
  it("a delete refused by the server keeps the modal open and shows the message", async () => {
    const board = makeBoard();
    const task = makeTask();
    const onDelete = vi.fn(() => Promise.reject(new Error("Task has an active session")));
    const onClose = vi.fn();
    render(<TaskEditModal task={task} board={board} {...baseProps} onSave={vi.fn()} onDelete={onDelete} boards={[board]} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => { expect(screen.getByText("Task has an active session")).toBeDefined(); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a successful delete closes the modal only after the caller's onDelete promise resolves", async () => {
    const board = makeBoard();
    const task = makeTask();
    const onDelete = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    render(<TaskEditModal task={task} board={board} {...baseProps} onSave={vi.fn()} onDelete={onDelete} boards={[board]} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => { expect(onDelete).toHaveBeenCalledTimes(1); });
    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });
  });
});

describe("TaskEditModal — dismissal guarded while in flight", () => {
  it("Escape does not close the modal while a save is in flight", () => {
    const board = makeBoard();
    const task = makeTask();
    const onSave = vi.fn(() => new Promise<void>(() => { /* never settles for this assertion */ }));
    const onClose = vi.fn();
    render(<TaskEditModal task={task} board={board} {...baseProps} onSave={onSave} onDelete={vi.fn()} boards={[board]} onClose={onClose} />);

    fireEvent.change(screen.getByDisplayValue("Original title"), { target: { value: "Edited title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape does not close the modal while a delete is in flight", () => {
    const board = makeBoard();
    const task = makeTask();
    const onDelete = vi.fn(() => new Promise<void>(() => { /* never settles for this assertion */ }));
    const onClose = vi.fn();
    render(<TaskEditModal task={task} board={board} {...baseProps} onSave={vi.fn()} onDelete={onDelete} boards={[board]} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });
});

// The operator's own report: reaching for the spawn action and hitting Save instead, over and over.
// Save being inert until something actually changed is what makes that misclick harmless.
describe("TaskEditModal — Save is refused until something changed", () => {
  function renderTask(task: EnrichedTask, onSave = vi.fn()) {
    const board = makeBoard();
    render(<TaskEditModal task={task} board={board} {...baseProps} onSave={onSave} onDelete={vi.fn()} boards={[board]} onClose={vi.fn()} />);
    return { onSave, save: screen.getByRole("button", { name: "Save" }) };
  }

  it("starts disabled on an untouched task and says why", () => {
    const { save } = renderTask(makeTask());
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("no changes")).toBeDefined();
  });

  it("enables on a title, description, column or priority edit", () => {
    const { save } = renderTask(makeTask());
    fireEvent.change(screen.getByDisplayValue("Original title"), { target: { value: "Edited" } });
    expect(save.hasAttribute("disabled")).toBe(false);

    cleanup();
    const second = renderTask(makeTask());
    fireEvent.click(screen.getByRole("button", { name: "P1" }));
    expect(second.save.hasAttribute("disabled")).toBe(false);
  });

  it("stays disabled when an edit is reverted, and when only surrounding whitespace was typed", () => {
    const { save } = renderTask(makeTask({ title: "Original title" }));
    const input = screen.getByDisplayValue("Original title");

    fireEvent.change(input, { target: { value: "Edited" } });
    fireEvent.change(input, { target: { value: "Original title" } });
    expect(save.hasAttribute("disabled")).toBe(true);

    // handleSave sends the TRIMMED title, so trailing space is not a change the server would see.
    fireEvent.change(input, { target: { value: "Original title  " } });
    expect(save.hasAttribute("disabled")).toBe(true);
  });

  // The stored title is compared TRIMMED on both sides. Comparing a trimmed input against a raw stored
  // value made a card whose title has surrounding whitespace — the server accepts one — open already
  // dirty, with no edit, and never return to clean.
  it("starts clean on a stored title that carries surrounding whitespace", () => {
    const { save } = renderTask(makeTask({ title: "  Spaced title  " }));
    expect(save.hasAttribute("disabled")).toBe(true);

    // getByDisplayValue normalizes whitespace, so this matches the padded value too.
    fireEvent.change(screen.getByDisplayValue("Spaced title"), { target: { value: "Spaced title" } });
    expect(save.hasAttribute("disabled")).toBe(true); // whitespace-only difference is still no change

    fireEvent.change(screen.getByDisplayValue("Spaced title"), { target: { value: "Different" } });
    expect(save.hasAttribute("disabled")).toBe(false);
  });
});

describe("TaskEditModal — Task / Run Claude tabs", () => {
  it("shows Save on the Task tab and the launch button on the Run Claude tab, never both", () => {
    const board = makeBoard();
    render(<TaskEditModal task={makeTask()} board={board} {...baseProps} onSave={vi.fn()} onDelete={vi.fn()} boards={[board]} onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Run Claude" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /Run Claude/ }));

    // The two primary actions never share a footer, so the one the operator aims at is the only one there.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Run Claude" })).toBeDefined();
    expect(screen.queryByDisplayValue("Original title")).toBeNull(); // the Task fields are off screen

    fireEvent.click(screen.getByRole("tab", { name: "Task" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  });

  it("keeps edits made on the Task tab across a round trip through the Run Claude tab", () => {
    const board = makeBoard();
    render(<TaskEditModal task={makeTask()} board={board} {...baseProps} onSave={vi.fn()} onDelete={vi.fn()} boards={[board]} onClose={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue("Original title"), { target: { value: "Edited title" } });
    fireEvent.click(screen.getByRole("tab", { name: /Run Claude/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Task" }));

    expect(screen.getByDisplayValue("Edited title")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
  });

  it("opens on the Task tab", () => {
    const board = makeBoard();
    render(<TaskEditModal task={makeTask()} board={board} {...baseProps} onSave={vi.fn()} onDelete={vi.fn()} boards={[board]} onClose={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Task" }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens on Run Claude when initialTab says so — the fix-issues entry point", () => {
    const board = makeBoard();
    render(<TaskEditModal task={makeTask()} board={board} {...baseProps} onSave={vi.fn()} onDelete={vi.fn()} boards={[board]} onClose={vi.fn()} initialTab="run" />);
    expect(screen.getByRole("tab", { name: /Run Claude/ }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("TaskEditModal — fix-issues extraPreset", () => {
  it("pre-selects the ephemeral preset ahead of the board's own, and never persists it", () => {
    const board = makeBoard({ spawnPresets: [{ id: "p1", text: "/existing" }], defaultSpawnPresetId: "p1" });
    const extraPreset = { id: "corral-doctor-fix", text: "/corral-doctor fix\n\nfix jq" };
    render(<TaskEditModal task={makeTask()} board={board} {...baseProps}
      envs={[{ id: "e1", label: "Env1", kind: "local", reachable: true }]}
      onSave={vi.fn()} onDelete={vi.fn()} boards={[board]} onClose={vi.fn()}
      initialTab="run" extraPreset={extraPreset} />);
    const option = screen.getByRole("option", { name: "/corral-doctor fix" });
    expect((option as HTMLOptionElement).selected).toBe(true);
    expect(board.spawnPresets).toEqual([{ id: "p1", text: "/existing" }]);
  });

  it("falls back to the board's own default preset when extraPreset is absent", () => {
    const board = makeBoard({ spawnPresets: [{ id: "p1", text: "/existing" }], defaultSpawnPresetId: "p1" });
    render(<TaskEditModal task={makeTask()} board={board} {...baseProps}
      envs={[{ id: "e1", label: "Env1", kind: "local", reachable: true }]}
      onSave={vi.fn()} onDelete={vi.fn()} boards={[board]} onClose={vi.fn()} initialTab="run" />);
    expect(screen.queryByRole("option", { name: "/corral-doctor fix" })).toBeNull();
    const option = screen.getByRole("option", { name: "/existing" });
    expect((option as HTMLOptionElement).selected).toBe(true);
  });
});

describe("TaskEditModal — Board/Project row layout", () => {
  it("keeps the Board select and Move button as siblings, with min-w-0 on the select so it can shrink below its widest option", () => {
    const board = makeBoard();
    const otherBoard = makeBoard({ id: "b2", label: "A".repeat(80) });
    const task = makeTask();
    render(<TaskEditModal task={task} board={board} {...baseProps} onSave={vi.fn()} onDelete={vi.fn()} boards={[board, otherBoard]} onClose={vi.fn()} />);

    // Picking a different board renders the Move button next to the select — the layout under test.
    fireEvent.change(screen.getByDisplayValue(board.label), { target: { value: otherBoard.id } });

    const moveButton = screen.getByRole("button", { name: "Move" });
    const row = moveButton.parentElement;
    expect(row).not.toBeNull();
    if (row === null) return;
    const select = Array.from(row.children).find((el): el is HTMLSelectElement => el instanceof HTMLSelectElement);
    expect(select).toBeDefined();
    if (select === undefined) return;
    // A <select> won't shrink below its widest option on its own — min-w-0 is what lets the flex-1
    // box actually shrink instead of pushing this row's shrink-0 sibling (the Move button) out.
    expect(select.className.split(/\s+/)).toContain("min-w-0");
  });
});
