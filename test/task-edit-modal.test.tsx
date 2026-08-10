// @vitest-environment jsdom
import type { Board, EnrichedTask } from "@shared/board-schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskEditModal } from "../web/src/components/TaskEditModal";

afterEach(cleanup);

function makeBoard(overrides: Partial<Board> = {}): Board {
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

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });
    expect(order).toEqual(["refresh", "close"]);
  });

  it("disables the Save button while the save is in flight", () => {
    const board = makeBoard();
    const task = makeTask();
    const onSave = vi.fn(() => new Promise<void>(() => { /* never settles for this assertion */ }));
    render(<TaskEditModal task={task} board={board} {...baseProps} onSave={onSave} onDelete={vi.fn()} boards={[board]} onClose={vi.fn()} />);

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
