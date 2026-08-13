// @vitest-environment jsdom
import type { Board, EnrichedTask } from "@shared/board-schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskEditModal } from "../web/src/components/TaskEditModal";
import type { SpawnRequestBody } from "../web/src/lib/api";
import type { SpawnEnvOption } from "../web/src/lib/use-spawn-form";
import { SPAWN_MODELS } from "../web/src/lib/use-spawn-form";

vi.mock("../web/src/lib/api", () => ({
  api: {
    envs: {
      spawnTargets: (env: string) => {
        if (env === "boom") return Promise.reject(new Error("herdr socket gone"));
        if (env === "empty") return Promise.resolve({ spaces: [], repos: [] });
        if (env === "other") return Promise.resolve({ spaces: [{ workspaceId: "w9", label: "other-space" }], repos: [] });
        return Promise.resolve({ spaces: [{ workspaceId: "w1", label: "space-one" }], repos: [{ name: "myrepo" }] });
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const envs: SpawnEnvOption[] = [
  { id: "local", label: "local", kind: "local", reachable: true },
  { id: "other", label: "other", kind: "local", reachable: true },
  { id: "empty", label: "empty", kind: "local", reachable: true }, // settled, genuinely no targets
  { id: "boom", label: "boom", kind: "local", reachable: true }, // the targets request itself fails
  { id: "far", label: "far", kind: "remote", reachable: true }, // remote → no start command
  { id: "down", label: "down", kind: "local", reachable: false }, // corral cannot reach it
];

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    id: "b1",
    label: "Board one",
    columns: [{ id: "c1", label: "To do" }],
    tasks: [],
    spawnPresets: [],
    defaultSpawnPresetId: null,
    ...overrides,
  };
}

function makeTask(): EnrichedTask {
  return {
    id: "t_abc1234", title: "Original title", description: "", status: "c1",
    priority: null, sessions: [], createdAt: 0, updatedAt: 0,
  };
}

const link = {
  env: "local", paneId: "p1", tabId: "t1", tabLabel: "t", workspaceId: "w1",
  workspaceLabel: "w", name: "n", cwdSnapshot: "/", sessionId: null,
};

function renderModal(board: Board, onSpawn: (body: SpawnRequestBody) => Promise<typeof link> = () => Promise.resolve(link)) {
  const onClose = vi.fn();
  const { rerender } = render(
    <TaskEditModal task={makeTask()} board={board} envs={envs} onSave={vi.fn()} onDelete={vi.fn()}
      onSpawn={onSpawn} onOpenSession={vi.fn()} boards={[board]} onMove={vi.fn()} onClose={onClose} />,
  );
  return { onClose, rerender };
}

function openRunTab(): void {
  fireEvent.click(screen.getByRole("tab", { name: /Run Claude/ }));
}

// None of these <select>s carries an accessible label (a pre-existing gap, out of scope here), so each
// is located via its own <label>'s next sibling rather than by role/name.
function getSelectAfter(labelText: string): HTMLSelectElement {
  const select = screen.getByText(labelText).nextElementSibling;
  if (!(select instanceof HTMLSelectElement)) throw new Error(`expected a <select> right after the ${labelText} label`);
  return select;
}

describe("spawn form — start-command preset select", () => {
  // What this pins is NOT the `value={selectedPreset?.id ?? ""}` binding: react-dom selects the first
  // non-disabled option whenever a controlled value matches none, so the raw-presetId binding renders
  // identically and no assertion here can tell the two apart. The load-bearing fact is that react-dom's
  // fallback is POSITIONAL — it lands on whatever option comes first. "no command" must therefore stay
  // first, and must mean "send nothing": promote a preset above it (or drop it) and a vanished default
  // silently becomes a real command the operator never picked, on a control that looks correctly filled.
  it("falls back to a first option that means 'no command' when the board's presets change under it", () => {
    const { rerender } = renderModal(makeBoard({ spawnPresets: [{ id: "p1", text: "/plan" }], defaultSpawnPresetId: "p1" }));
    openRunTab();
    expect(getSelectAfter("Start command").value).toBe("p1");

    // Simulate the board's presets changing under an open modal (an SSE update) — "p1" is gone.
    const board2 = makeBoard({ spawnPresets: [{ id: "p2", text: "/other" }], defaultSpawnPresetId: "p1" });
    rerender(
      <TaskEditModal task={makeTask()} board={board2} envs={envs} onSave={vi.fn()} onDelete={vi.fn()}
        onSpawn={vi.fn()} onOpenSession={vi.fn()} boards={[board2]} onMove={vi.fn()} onClose={vi.fn()} />,
    );

    const select = getSelectAfter("Start command");
    expect(select.options[0]?.value).toBe(""); // the fallback react-dom will land on
    expect(select.selectedOptions).toHaveLength(1);
    expect(select.selectedOptions[0]?.textContent).toBe("no command");
    expect(select.value).toBe("");
  });

  it("keeps the hint text and the spawned startCommand in agreement with what the select displays", async () => {
    const onSpawn = vi.fn((_body: SpawnRequestBody) => Promise.resolve(link));
    const { rerender } = renderModal(makeBoard({ spawnPresets: [{ id: "p1", text: "/plan" }], defaultSpawnPresetId: "p1" }), onSpawn);
    openRunTab();
    const board2 = makeBoard({ spawnPresets: [{ id: "p2", text: "/other" }], defaultSpawnPresetId: "p1" });
    rerender(
      <TaskEditModal task={makeTask()} board={board2} envs={envs} onSave={vi.fn()} onDelete={vi.fn()}
        onSpawn={onSpawn} onOpenSession={vi.fn()} boards={[board2]} onMove={vi.fn()} onClose={vi.fn()} />,
    );

    // The hint must match "no command" being displayed, not the stale preset's text.
    expect(screen.getByText(/^Edited in Board settings/)).toBeDefined();
    expect(screen.queryByText(/\/plan/)).toBeNull();

    const run = screen.getByRole("button", { name: "Run Claude" });
    await waitFor(() => { expect(run.hasAttribute("disabled")).toBe(false); });
    fireEvent.click(run);

    await waitFor(() => { expect(onSpawn).toHaveBeenCalledTimes(1); });
    const [body] = onSpawn.mock.calls[0] ?? [];
    expect(body).toBeDefined();
    if (body === undefined) return;
    // buildSpawnRequest omits startCommand entirely when there is none — it must not carry "/plan".
    expect(Object.prototype.hasOwnProperty.call(body, "startCommand")).toBe(false);
  });
});

describe("spawn form — remembered picks", () => {
  it("restores the last env, its target, and the model from localStorage", async () => {
    window.localStorage.setItem("corral.spawn.prefs", JSON.stringify({
      env: "other", targetByEnv: { other: "w9", local: "w1" }, model: "opus",
    }));
    renderModal(makeBoard());
    openRunTab();

    expect(getSelectAfter("Environment").value).toBe("other");
    expect(getSelectAfter("Model").value).toBe("opus");
    await waitFor(() => { expect(getSelectAfter("Where it runs").value).toBe("w9"); });
  });

  it("ignores a remembered env that no longer exists, and a target the env no longer offers", async () => {
    window.localStorage.setItem("corral.spawn.prefs", JSON.stringify({
      env: "vanished", targetByEnv: { local: "w-deleted" }, model: "nonsense",
    }));
    renderModal(makeBoard());
    openRunTab();

    expect(getSelectAfter("Environment").value).toBe("local"); // first env, not the vanished one
    expect(getSelectAfter("Model").value).toBe(""); // "default", not an unknown model
    // The remembered space is gone from the fetched list, so the first offered target wins instead.
    await waitFor(() => { expect(getSelectAfter("Where it runs").value).toBe("w1"); });
  });

  it("persists an explicit pick, and does not persist an env that was only defaulted to", async () => {
    renderModal(makeBoard());
    openRunTab();
    await waitFor(() => { expect(getSelectAfter("Where it runs").value).toBe("w1"); });

    // Nothing was chosen by hand yet — the defaults must not have been written back.
    expect(window.localStorage.getItem("corral.spawn.prefs")).toBeNull();

    fireEvent.change(getSelectAfter("Environment"), { target: { value: "other" } });
    await waitFor(() => { expect(getSelectAfter("Where it runs").value).toBe("w9"); });
    fireEvent.change(getSelectAfter("Model"), { target: { value: "fable" } });

    const stored: unknown = JSON.parse(window.localStorage.getItem("corral.spawn.prefs") ?? "null");
    expect(stored).toMatchObject({ env: "other", model: "fable" });
  });

  // A target picked by hand used to be read back from a mount-time snapshot, so it was lost the moment
  // the operator went to another env and returned — the pick survived a page reload but not a round trip.
  it("keeps a hand-picked target when the env is switched away and back", async () => {
    renderModal(makeBoard());
    openRunTab();
    await waitFor(() => { expect(getSelectAfter("Where it runs").value).toBe("w1"); });

    fireEvent.change(getSelectAfter("Where it runs"), { target: { value: "new:myrepo" } });
    fireEvent.change(getSelectAfter("Environment"), { target: { value: "other" } });
    await waitFor(() => { expect(getSelectAfter("Where it runs").value).toBe("w9"); });
    fireEvent.change(getSelectAfter("Environment"), { target: { value: "local" } });

    await waitFor(() => { expect(getSelectAfter("Where it runs").value).toBe("new:myrepo"); });
  });

  it("remembers Remote Control, including switching it back off", () => {
    renderModal(makeBoard());
    openRunTab();
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.hasAttribute("checked")).toBe(false); // off until the operator says otherwise

    fireEvent.click(checkbox);
    expect(JSON.parse(window.localStorage.getItem("corral.spawn.prefs") ?? "null")).toMatchObject({ remoteControl: true });

    fireEvent.click(checkbox);
    expect(JSON.parse(window.localStorage.getItem("corral.spawn.prefs") ?? "null")).toMatchObject({ remoteControl: false });
  });

  it("restores a remembered Remote Control tick and sends it on the spawn", async () => {
    window.localStorage.setItem("corral.spawn.prefs", JSON.stringify({ remoteControl: true }));
    const onSpawn = vi.fn((_body: SpawnRequestBody) => Promise.resolve(link));
    renderModal(makeBoard(), onSpawn);
    openRunTab();

    const checkbox = screen.getByRole("checkbox");
    if (!(checkbox instanceof HTMLInputElement)) throw new Error("expected a checkbox input");
    expect(checkbox.checked).toBe(true);

    const run = screen.getByRole("button", { name: "Run Claude" });
    await waitFor(() => { expect(run.hasAttribute("disabled")).toBe(false); });
    fireEvent.click(run);

    await waitFor(() => { expect(onSpawn).toHaveBeenCalledTimes(1); });
    expect(onSpawn.mock.calls[0]?.[0]).toMatchObject({ remoteControl: true });
  });

  // The picker and the remembered-value check used to be two hand-kept lists in two files.
  it("offers exactly the models a remembered pick is validated against", () => {
    renderModal(makeBoard());
    openRunTab();
    expect(Array.from(getSelectAfter("Model").options).map((o) => o.value)).toEqual([...SPAWN_MODELS]);
  });
});

// "Empty" is a settled result, not a loading one — the distinction these four messages exist for.
describe("spawn form — why a target cannot be picked", () => {
  it("says the env has no spaces or repos, and keeps the launch button off", async () => {
    renderModal(makeBoard());
    openRunTab();
    fireEvent.change(getSelectAfter("Environment"), { target: { value: "empty" } });

    await waitFor(() => { expect(screen.getByText(/No spaces or configured repos/)).toBeDefined(); });
    expect(getSelectAfter("Where it runs").hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Run Claude" }).hasAttribute("disabled")).toBe(true);
  });

  it("reports a failed targets request with the server's message", async () => {
    renderModal(makeBoard());
    openRunTab();
    fireEvent.change(getSelectAfter("Environment"), { target: { value: "boom" } });

    await waitFor(() => { expect(screen.getByText(/herdr socket gone/)).toBeDefined(); });
    expect(screen.getByRole("button", { name: "Run Claude" }).hasAttribute("disabled")).toBe(true);
  });

  it("distinguishes an unreachable env from an empty one", async () => {
    renderModal(makeBoard());
    openRunTab();
    fireEvent.change(getSelectAfter("Environment"), { target: { value: "down" } });

    await waitFor(() => { expect(screen.getByText(/cannot reach this environment/)).toBeDefined(); });
    expect(screen.queryByText(/No spaces or configured repos/)).toBeNull();
  });

  it("locks the start command on a remote env and says the pick is kept", async () => {
    renderModal(makeBoard({ spawnPresets: [{ id: "p1", text: "/plan" }], defaultSpawnPresetId: "p1" }));
    openRunTab();
    fireEvent.change(getSelectAfter("Environment"), { target: { value: "far" } });

    await waitFor(() => { expect(screen.getByText(/local environments only/)).toBeDefined(); });
    expect(getSelectAfter("Start command").hasAttribute("disabled")).toBe(true);
    expect(getSelectAfter("Start command").value).toBe("p1"); // kept, not cleared
  });
});

describe("spawn form — a refused or in-flight spawn", () => {
  it("keeps the modal open and shows the server's message when the spawn is refused", async () => {
    const { onClose } = renderModal(makeBoard(), () => Promise.reject(new Error("herdr refused: no such repo")));
    openRunTab();

    const run = screen.getByRole("button", { name: "Run Claude" });
    await waitFor(() => { expect(run.hasAttribute("disabled")).toBe(false); });
    fireEvent.click(run);

    await waitFor(() => { expect(screen.getByText("herdr refused: no such repo")).toBeDefined(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Run Claude" }).hasAttribute("disabled")).toBe(false);
  });

  // Every exit from the modal has to honor the same guard, or a dismissal races the spawn's result and
  // a session the operator believes they dismissed opens anyway.
  it("blocks every way out of the modal while the spawn is in flight", async () => {
    const { onClose } = renderModal(makeBoard(), () => new Promise(() => { /* never settles */ }));
    openRunTab();

    const run = screen.getByRole("button", { name: "Run Claude" });
    await waitFor(() => { expect(run.hasAttribute("disabled")).toBe(false); });
    fireEvent.click(run);

    expect(screen.getByRole("button", { name: "Starting…" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("tab", { name: "Task" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("spawn form — state outlives a tab switch", () => {
  it("keeps the target, the model and the Remote Control tick across Run → Task → Run", async () => {
    renderModal(makeBoard());
    openRunTab();
    await waitFor(() => { expect(getSelectAfter("Where it runs").value).toBe("w1"); });

    fireEvent.change(getSelectAfter("Where it runs"), { target: { value: "new:myrepo" } });
    fireEvent.change(getSelectAfter("Model"), { target: { value: "opus" } });
    fireEvent.click(screen.getByRole("checkbox"));

    fireEvent.click(screen.getByRole("tab", { name: "Task" }));
    openRunTab();

    expect(getSelectAfter("Where it runs").value).toBe("new:myrepo");
    expect(getSelectAfter("Model").value).toBe("opus");
    const checkbox = screen.getByRole("checkbox");
    if (!(checkbox instanceof HTMLInputElement)) throw new Error("expected a checkbox input");
    expect(checkbox.checked).toBe(true);
  });
});
