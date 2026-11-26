// @vitest-environment jsdom
import type { BoardFrame, Task } from "@shared/board-schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardSettingsModal } from "../web/src/components/BoardSettingsModal";

afterEach(cleanup);

function makeBoard(overrides: Partial<BoardFrame> = {}): BoardFrame {
  return {
    id: "b1",
    label: "Original name",
    columns: [{ id: "c1", label: "To do" }, { id: "c2", label: "Done", type: "closed" }],
    tasks: [],
    description: "",
    spawnPresets: [{ id: "p1", title: "", text: "/plan" }],
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
    log: [],
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
    fireEvent.click(screen.getByRole("button", { name: "Edit start command /plan" }));
    fireEvent.change(screen.getByDisplayValue("/plan"), { target: { value: "/replan" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => { expect(screen.getByText("Boards service unavailable")).toBeDefined(); });

    // Still mounted: the parent never received onClose, so it would still render this modal.
    expect(onClose).not.toHaveBeenCalled();
    // Edits survived the refusal — none of the three fields reverted to their pre-edit value.
    expect(screen.getByDisplayValue("Edited name")).toBeDefined();
    expect(screen.getByDisplayValue("Doing")).toBeDefined();
    expect(screen.getByRole("button", { name: "Edit start command /replan" })).toBeDefined();
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

// The prop's own patch shape — not exported by the component, and the mock has to carry it or
// `onSave.mock.calls` types as an empty tuple and the assertions below have nothing to read.
type SavePatch = Parameters<React.ComponentProps<typeof BoardSettingsModal>["onSave"]>[0];

describe("BoardSettingsModal — start-command editor", () => {
  function open(onSave = vi.fn((_patch: SavePatch) => Promise.resolve()), onClose = vi.fn()) {
    render(<BoardSettingsModal board={makeBoard()} onSave={onSave} onDelete={vi.fn()} onClose={onClose} />);
    return { onSave, onClose };
  }

  it("adds a titled multi-line command through the editor and saves it", async () => {
    const { onSave } = open();
    fireEvent.click(screen.getByRole("button", { name: "Add start command" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "  Review PR " } });
    fireEvent.change(screen.getByLabelText(/^Text/), { target: { value: "/review\nRead the card first.\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.getByRole("button", { name: "Edit start command Review PR" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => { expect(onSave).toHaveBeenCalledTimes(1); });
    const saved = onSave.mock.calls[0]?.[0].spawnPresets;
    expect(saved?.[1]).toMatchObject({ title: "Review PR", text: "/review\nRead the card first." });
  });

  it("adds nothing when a new command is cancelled", async () => {
    const { onSave } = open();
    fireEvent.click(screen.getByRole("button", { name: "Add start command" }));
    fireEvent.change(screen.getByLabelText(/^Text/), { target: { value: "/abandoned" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]!);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => { expect(onSave).toHaveBeenCalledTimes(1); });
    expect(onSave.mock.calls[0]?.[0].spawnPresets).toEqual([{ id: "p1", title: "", text: "/plan" }]);
  });

  it("keeps Done disabled for blank text and names the accepted format for a non-Latin opening", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Add start command" }));
    const done = screen.getByRole("button", { name: "Done" });
    fireEvent.change(screen.getByLabelText(/^Text/), { target: { value: "   " } });
    expect(done.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText(/^Text/), { target: { value: "Продолжи работу" } });
    expect(done.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/must begin with "\/" or an ASCII letter or digit/)).toBeDefined();
  });

  it("Escape in the editor closes only the editor and keeps the settings edits", () => {
    const { onClose } = open();
    fireEvent.change(screen.getByDisplayValue("Original name"), { target: { value: "Edited name" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit start command /plan" }));
    fireEvent.keyDown(screen.getByLabelText(/^Text/), { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByLabelText(/^Text/)).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores window Escape and the settings backdrop while the editor is open", () => {
    const { onClose } = open();
    fireEvent.click(screen.getByRole("button", { name: "Edit start command /plan" }));
    fireEvent.keyDown(window, { key: "Escape" });
    const dialogs = screen.getAllByRole("dialog");
    fireEvent.click(dialogs[0]!);
    fireEvent.click(dialogs[1]!);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Text/)).toBeDefined();
  });

  it("clears the default when its command is removed", async () => {
    const { onSave } = open();
    fireEvent.click(screen.getByRole("radio", { name: "Default for new sessions: /plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove start command /plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => { expect(onSave).toHaveBeenCalledTimes(1); });
    expect(onSave.mock.calls[0]?.[0].defaultSpawnPresetId).toBeNull();
  });
});

describe("BoardSettingsModal — board description", () => {
  it("shows the stored description and saves the edited one trimmed", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(<BoardSettingsModal board={makeBoard({ description: "Ship 1.0" })} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByLabelText("Board description")).toHaveProperty("value", "Ship 1.0");
    fireEvent.change(screen.getByLabelText("Board description"), { target: { value: "  Stabilise first\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => { expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ description: "Stabilise first" })); });
  });
});

describe("BoardSettingsModal — board description, untouched", () => {
  it("saves the stored description back unchanged when it was not edited", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(<BoardSettingsModal board={makeBoard({ description: "Ship 1.0" })} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => { expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ description: "Ship 1.0" })); });
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
