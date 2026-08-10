// @vitest-environment jsdom
import type { Board, Task } from "@shared/board-schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardSettingsModal } from "../web/src/components/BoardSettingsModal";

afterEach(cleanup);

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    id: "b1",
    label: "Original name",
    columns: [{ id: "c1", label: "To do" }, { id: "c2", label: "Done", type: "closed" }],
    tasks: [],
    spawnPresets: [{ id: "p1", text: "/plan" }],
    defaultSpawnPresetId: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t_abc1234",
    title: "Some task",
    description: "",
    status: "c1",
    priority: null,
    sessions: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("BoardSettingsModal — save error channel", () => {
  it("a save refused by the server keeps the modal open, shows the server's message, and keeps the user's edits", async () => {
    const onSave = vi.fn(() => Promise.reject(new Error("Boards service unavailable")));
    const onClose = vi.fn();
    render(<BoardSettingsModal board={makeBoard()} onSave={onSave} onDelete={vi.fn()} onClose={onClose} />);

    fireEvent.change(screen.getByDisplayValue("Original name"), { target: { value: "Edited name" } });
    fireEvent.change(screen.getByDisplayValue("To do"), { target: { value: "Doing" } });
    fireEvent.change(screen.getByDisplayValue("/plan"), { target: { value: "/replan" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => { expect(screen.getByText("Boards service unavailable")).toBeDefined(); });

    // Still mounted: the parent never received onClose, so it would still render this modal.
    expect(onClose).not.toHaveBeenCalled();
    // Edits survived the refusal — none of the three fields reverted to their pre-edit value.
    expect(screen.getByDisplayValue("Edited name")).toBeDefined();
    expect(screen.getByDisplayValue("Doing")).toBeDefined();
    expect(screen.getByDisplayValue("/replan")).toBeDefined();
  });

  it("waits for the onSave promise it was given to resolve before closing — never closes eagerly", async () => {
    const order: string[] = [];
    const onSave = vi.fn(() => Promise.resolve().then(() => { order.push("resolved"); }));
    const onClose = vi.fn(() => { order.push("close"); });
    render(<BoardSettingsModal board={makeBoard()} onSave={onSave} onDelete={vi.fn()} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });
    // Not a bare "both were called" check: closing before the onSave promise settles is exactly the
    // historical bug (App.tsx's old fire-and-forget onSave, pre-f423d54), so the ORDER is the thing
    // under test. This guards the MODAL's own contract only — App.tsx's current onSave chains a
    // refreshBoards() call that is itself fire-and-forget for the list()/state() refetch, so a real
    // save still closes the modal before that refetch completes. Do not read this test as proof the
    // board list is fully refreshed by the time the modal closes.
    expect(order).toEqual(["resolved", "close"]);
  });

  it("disables the Save button while the save is in flight", () => {
    const onSave = vi.fn(() => new Promise<void>(() => { /* never settles for this assertion */ }));
    render(<BoardSettingsModal board={makeBoard()} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />);

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(saveButton);
    expect(saveButton.hasAttribute("disabled")).toBe(true);
  });
});

describe("BoardSettingsModal — delete board", () => {
  it("disables Delete with a visible reason when the board still has tasks", () => {
    const board = makeBoard({ tasks: [makeTask()] });
    render(<BoardSettingsModal board={board} onSave={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />);

    const deleteButton = screen.getByRole("button", { name: "Delete board" });
    expect(deleteButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/available only for an empty board/i)).toBeDefined();
  });

  it("confirm-then-delete on an empty board calls through and closes the modal", async () => {
    const onDelete = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    render(<BoardSettingsModal board={makeBoard()} onSave={vi.fn()} onDelete={onDelete} onClose={onClose} />);

    const deleteButton = screen.getByRole("button", { name: "Delete board" });
    expect(deleteButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(deleteButton);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => { expect(onDelete).toHaveBeenCalledTimes(1); });
    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });
  });

  it("a server refusal on delete renders in the footer's saveError channel and leaves the modal open", async () => {
    const onDelete = vi.fn(() => Promise.reject(new Error("Board has 1 task — delete or move them first.")));
    const onClose = vi.fn();
    render(<BoardSettingsModal board={makeBoard()} onSave={vi.fn()} onDelete={onDelete} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete board" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => { expect(screen.getByText("Board has 1 task — delete or move them first.")).toBeDefined(); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not show two identically-labelled Cancel controls while the delete confirmation is open", () => {
    render(<BoardSettingsModal board={makeBoard()} onSave={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete board" }));

    // Two distinct actions ("abandon the delete confirmation" vs. "close the modal") must not share
    // one ambiguous label.
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
  });
});

describe("BoardSettingsModal — dismissal guarded while in flight", () => {
  it("Escape does not close the modal while a save is in flight", () => {
    const onSave = vi.fn(() => new Promise<void>(() => { /* never settles for this assertion */ }));
    const onClose = vi.fn();
    render(<BoardSettingsModal board={makeBoard()} onSave={onSave} onDelete={vi.fn()} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape does not close the modal while a delete is in flight", () => {
    const onDelete = vi.fn(() => new Promise<void>(() => { /* never settles for this assertion */ }));
    const onClose = vi.fn();
    render(<BoardSettingsModal board={makeBoard()} onSave={vi.fn()} onDelete={onDelete} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete board" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("clicking the overlay does not close the modal while a save is in flight", () => {
    const onSave = vi.fn(() => new Promise<void>(() => { /* never settles for this assertion */ }));
    const onClose = vi.fn();
    const { container } = render(<BoardSettingsModal board={makeBoard()} onSave={onSave} onDelete={vi.fn()} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const overlay = container.querySelector('[role="dialog"]');
    expect(overlay).not.toBeNull();
    if (overlay !== null) fireEvent.click(overlay);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables the Cancel button while a save is in flight", () => {
    const onSave = vi.fn(() => new Promise<void>(() => { /* never settles for this assertion */ }));
    render(<BoardSettingsModal board={makeBoard()} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("BoardSettingsModal — footer layout under a long disabled-reason plus a saveError", () => {
  // jsdom does not compute real geometry, so this cannot see the actual zero-width collapse or the
  // painted overlap. It guards the two DOM preconditions that produced it instead: the footer renders
  // as a COLUMN (so saveError's row never shares space with the actions row), and saveError is not
  // nested anywhere inside that actions row — not just its innermost Cancel/Save group. The footer
  // handle is found structurally (the card's last child), independent of where saveError or the
  // actions row end up, so relocating either one cannot make the handle follow the bug.
  it("keeps the footer column-stacked and saveError out of the actions row", async () => {
    const board = makeBoard({ tasks: [makeTask(), makeTask({ id: "t2" })] });
    const onSave = vi.fn(() => Promise.reject(new Error("Boards service unavailable")));
    const { container } = render(<BoardSettingsModal board={board} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />);

    // The long disabled-reason is present (board has tasks).
    expect(screen.getByText(/available only for an empty board \(2 tasks\)/i)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const errorEl = await waitFor(() => screen.getByText("Boards service unavailable"));

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    if (dialog === null) return;
    const card = dialog.firstElementChild;
    expect(card).not.toBeNull();
    if (card === null) return;
    const footer = card.lastElementChild;
    expect(footer).not.toBeNull();
    if (footer === null) return;

    expect(footer.contains(errorEl)).toBe(true);
    expect(footer.className).toMatch(/\bflex-col\b/);

    // Walk up from Save to whichever of the footer's direct children carries it — the actions row.
    const saveButton = screen.getByRole("button", { name: "Save" });
    let node: Element | null = saveButton;
    while (node !== null && node.parentElement !== footer) node = node.parentElement;
    expect(node).not.toBeNull();
    if (node !== null) expect(node.contains(errorEl)).toBe(false);
  });
});
