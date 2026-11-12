// @vitest-environment jsdom
import type { Board, EnrichedTask } from "@shared/board-schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskEditModal } from "../web/src/components/TaskEditModal";
import type { SpawnRequestBody } from "../web/src/lib/api";
import type { SpawnEnvOption } from "../web/src/lib/use-spawn-form";

vi.mock("../web/src/lib/api", () => ({
  api: {
    envs: {
      spawnTargets: () => Promise.resolve({ spaces: [{ workspaceId: "w1", label: "space-one" }], repos: [] }),
    },
  },
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const envs: SpawnEnvOption[] = [{ id: "local", label: "local", reachable: true }];

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    id: "b1", label: "Board one", columns: [{ id: "c1", label: "To do" }], tasks: [],
    description: "", spawnPresets: [], defaultSpawnPresetId: null, ...overrides,
  };
}

function makeTask(overrides: Partial<EnrichedTask> = {}): EnrichedTask {
  return {
    id: "t_abc1234", title: "Original title", description: "Do the thing", status: "c1",
    priority: null, sessions: [], createdAt: 0, updatedAt: 0, logCount: 0, noteCount: 0, lastLogAtMs: null,
    ...overrides,
  };
}

const link = {
  env: "local", paneId: "p1", tabId: "t1", tabLabel: "t", workspaceId: "w1",
  workspaceLabel: "w", name: "n", cwdSnapshot: "/", sessionId: null,
};

interface Handlers {
  readonly task?: EnrichedTask;
  readonly board?: Board;
  readonly onSave?: (patch: unknown) => Promise<void>;
  readonly onSpawn?: (body: SpawnRequestBody) => Promise<typeof link>;
}

function renderModal({ task = makeTask(), board = makeBoard(), onSave = vi.fn(() => Promise.resolve()), onSpawn = vi.fn(() => Promise.resolve(link)) }: Handlers = {}) {
  const onClose = vi.fn();
  const onOpenSession = vi.fn();
  render(
    <TaskEditModal task={task} board={board} envs={envs} onSave={onSave} onDelete={vi.fn()}
      onSpawn={onSpawn} onOpenSession={onOpenSession} boards={[board]} onMove={vi.fn()} onClose={onClose} />,
  );
  return { onClose, onOpenSession, onSave, onSpawn };
}

async function openRunTab(): Promise<void> {
  fireEvent.click(screen.getByRole("tab", { name: /Run Claude/ }));
  await waitFor(() => { expect(screen.getByRole("button", { name: "Run Claude" }).hasAttribute("disabled")).toBe(false); });
}

describe("launch — the two halves of the Run button", () => {
  it("Run Claude spawns, closes, and opens the terminal", async () => {
    const h = renderModal();
    await openRunTab();
    fireEvent.click(screen.getByRole("button", { name: "Run Claude" }));

    await waitFor(() => { expect(h.onClose).toHaveBeenCalledTimes(1); });
    expect(h.onOpenSession).toHaveBeenCalledWith("local", "p1", true, "Original title");
  });

  it("Run in background spawns and closes, but never opens the terminal", async () => {
    const h = renderModal();
    await openRunTab();
    fireEvent.click(screen.getByRole("button", { name: "Run in background" }));

    await waitFor(() => { expect(h.onClose).toHaveBeenCalledTimes(1); });
    expect(h.onSpawn).toHaveBeenCalledTimes(1);
    expect(h.onOpenSession).not.toHaveBeenCalled();
  });

  it("the background half carries its own hover bubble instead of a browser title tooltip", async () => {
    renderModal();
    await openRunTab();
    const half = screen.getByRole("button", { name: "Run in background" });
    expect(half.hasAttribute("title")).toBe(false);
    const bubble = screen.getByRole("tooltip", { hidden: true });
    expect(bubble.textContent).toContain("Run in background — no terminal");
    // The bubble is shown by hovering the half's wrapper, so it must share that wrapper's group.
    expect(half.parentElement?.className.split(/\s+/)).toContain("group/bg");
    expect(bubble.className.split(/\s+/)).toContain("group-hover/bg:block");
  });

  it("both halves send the preset selected on the Run tab", async () => {
    const board = makeBoard({ spawnPresets: [{ id: "p1", text: "/plan" }], defaultSpawnPresetId: "p1" });
    const onSpawn = vi.fn((_body: SpawnRequestBody) => Promise.resolve(link));
    renderModal({ board, onSpawn });
    await openRunTab();
    fireEvent.click(screen.getByRole("button", { name: "Run in background" }));

    await waitFor(() => { expect(onSpawn).toHaveBeenCalledTimes(1); });
    expect(onSpawn.mock.calls[0]?.[0]).toMatchObject({ startCommand: "/plan" });
  });

  it("both halves are disabled while a launch is in flight", async () => {
    renderModal({ onSpawn: vi.fn(() => new Promise<typeof link>(() => { /* never settles */ })) });
    await openRunTab();
    fireEvent.click(screen.getByRole("button", { name: "Run in background" }));

    await waitFor(() => { expect(screen.getByRole("button", { name: "Starting…" }).hasAttribute("disabled")).toBe(true); });
    expect(screen.getByRole("button", { name: "Run in background" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("launch — unsaved edits are saved first", () => {
  it("saves the edited title, description, column and priority before spawning", async () => {
    const order: string[] = [];
    const onSave = vi.fn(() => { order.push("save"); return Promise.resolve(); });
    const onSpawn = vi.fn(() => { order.push("spawn"); return Promise.resolve(link); });
    const h = renderModal({ onSave, onSpawn });

    fireEvent.change(screen.getByDisplayValue("Original title"), { target: { value: "Edited title" } });
    fireEvent.change(screen.getByDisplayValue("Do the thing"), { target: { value: "Do it better" } });
    fireEvent.click(screen.getByRole("button", { name: "P1" }));
    await openRunTab();
    fireEvent.click(screen.getByRole("button", { name: "Run Claude" }));

    await waitFor(() => { expect(h.onClose).toHaveBeenCalledTimes(1); });
    expect(order).toEqual(["save", "spawn"]);
    expect(onSave).toHaveBeenCalledWith({ title: "Edited title", description: "Do it better", status: "c1", priority: "p1" });
    // The terminal header carries the title that was just saved, not the one the modal opened with.
    expect(h.onOpenSession).toHaveBeenCalledWith("local", "p1", true, "Edited title");
  });

  it("does not save when only the card changed underneath an untouched form", async () => {
    const board = makeBoard();
    const onSave = vi.fn(() => Promise.resolve());
    const onSpawn = vi.fn(() => Promise.resolve(link));
    const onClose = vi.fn();
    const props = { board, envs, onSave, onDelete: vi.fn(), onSpawn, onOpenSession: vi.fn(), boards: [board], onMove: vi.fn(), onClose };
    const { rerender } = render(<TaskEditModal task={makeTask()} {...props} />);
    // Another session rewrote the description while the modal was open.
    rerender(<TaskEditModal task={makeTask({ description: "rewritten by a session" })} {...props} />);
    await openRunTab();
    fireEvent.click(screen.getByRole("button", { name: "Run in background" }));

    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not save when nothing changed", async () => {
    const h = renderModal();
    await openRunTab();
    fireEvent.click(screen.getByRole("button", { name: "Run in background" }));

    await waitFor(() => { expect(h.onClose).toHaveBeenCalledTimes(1); });
    expect(h.onSave).not.toHaveBeenCalled();
  });

  it("a refused save shows the message, keeps the modal open and never spawns", async () => {
    const h = renderModal({ onSave: vi.fn(() => Promise.reject(new Error("title must not be empty"))) });
    fireEvent.change(screen.getByDisplayValue("Original title"), { target: { value: "Edited title" } });
    await openRunTab();
    fireEvent.click(screen.getByRole("button", { name: "Run Claude" }));

    await waitFor(() => { expect(screen.getByText("title must not be empty")).toBeDefined(); });
    expect(h.onSpawn).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Run Claude" }).hasAttribute("disabled")).toBe(false);
  });

  it("reads Saving… while the save is in flight, and blocks dismissal", async () => {
    const h = renderModal({ onSave: vi.fn(() => new Promise<void>(() => { /* never settles */ })) });
    fireEvent.change(screen.getByDisplayValue("Original title"), { target: { value: "Edited title" } });
    await openRunTab();
    fireEvent.click(screen.getByRole("button", { name: "Run Claude" }));

    await waitFor(() => { expect(screen.getByRole("button", { name: "Saving…" }).hasAttribute("disabled")).toBe(true); });
    expect(screen.getByRole("button", { name: "Run in background" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("tab", { name: "Task" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(h.onClose).not.toHaveBeenCalled();
  });
});

describe("launch — empty description warning", () => {
  it("warns on the Run tab when the description is blank, and still allows the launch", async () => {
    const h = renderModal({ task: makeTask({ description: "" }) });
    expect(screen.queryByText(/description is empty/)).toBeNull(); // Task tab: no warning
    await openRunTab();
    expect(screen.getByText(/description is empty/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Run Claude" }));
    await waitFor(() => { expect(h.onSpawn).toHaveBeenCalledTimes(1); });
  });

  it("goes away once a description is typed, even before it is saved", async () => {
    renderModal({ task: makeTask({ description: "" }) });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "now there is one" } });
    await openRunTab();
    expect(screen.queryByText(/description is empty/)).toBeNull();
  });
});
