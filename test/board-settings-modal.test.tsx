// @vitest-environment jsdom
import type { Board } from "@shared/board-schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardSettingsModal } from "../web/src/components/BoardSettingsModal";

afterEach(cleanup);

function makeBoard(): Board {
  return {
    id: "b1",
    label: "Original name",
    columns: [{ id: "c1", label: "To do" }, { id: "c2", label: "Done", type: "closed" }],
    tasks: [],
    spawnPresets: [{ id: "p1", text: "/plan" }],
    defaultSpawnPresetId: null,
  };
}

describe("BoardSettingsModal — save error channel", () => {
  it("a save refused by the server keeps the modal open, shows the server's message, and keeps the user's edits", async () => {
    const onSave = vi.fn(() => Promise.reject(new Error("Boards service unavailable")));
    const onClose = vi.fn();
    render(<BoardSettingsModal board={makeBoard()} onSave={onSave} onClose={onClose} />);

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

  it("a successful save closes the modal only after the caller's onSave promise (board refresh) resolves", async () => {
    const order: string[] = [];
    const onSave = vi.fn(() => Promise.resolve().then(() => { order.push("refresh"); }));
    const onClose = vi.fn(() => { order.push("close"); });
    render(<BoardSettingsModal board={makeBoard()} onSave={onSave} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });
    // Not a bare "both were called" check: closing before the refresh promise settles is exactly the
    // bug (App.tsx's old fire-and-forget onSave), so the ORDER is the thing under test.
    expect(order).toEqual(["refresh", "close"]);
  });

  it("disables the Save button while the save is in flight", () => {
    const onSave = vi.fn(() => new Promise<void>(() => { /* never settles for this assertion */ }));
    render(<BoardSettingsModal board={makeBoard()} onSave={onSave} onClose={vi.fn()} />);

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(saveButton);
    expect(saveButton.hasAttribute("disabled")).toBe(true);
  });
});
