// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SpawnEnvOption } from "../web/src/components/SpawnPanel";
import { SpawnPanel } from "../web/src/components/SpawnPanel";
import type { SpawnRequestBody } from "../web/src/lib/api";

vi.mock("../web/src/lib/api", () => ({
  api: { envs: { spawnTargets: () => Promise.resolve({ spaces: [], repos: [{ name: "myrepo" }] }) } },
}));

afterEach(cleanup);

const envs: SpawnEnvOption[] = [{ id: "local", label: "local", kind: "local", reachable: true }];

// The "Start command" <select> carries no accessible label (a pre-existing gap, out of scope here),
// so it's located via its own <label>'s next sibling rather than by role/name.
function getStartCommandSelect(): HTMLSelectElement {
  const label = screen.getByText("Start command");
  const select = label.nextElementSibling;
  if (!(select instanceof HTMLSelectElement)) throw new Error("expected a <select> right after the Start command label");
  return select;
}

describe("SpawnPanel — start-command preset select", () => {
  // What this pins is NOT the `value={selectedPreset?.id ?? ""}` binding: react-dom selects the first
  // non-disabled option whenever a controlled value matches none, so the raw-presetId binding renders
  // identically and no assertion here can tell the two apart. The load-bearing fact is that react-dom's
  // fallback is POSITIONAL — it lands on whatever option comes first. "no command" must therefore stay
  // first, and must mean "send nothing": promote a preset above it (or drop it) and a vanished default
  // silently becomes a real command the operator never picked, on a control that looks correctly filled.
  it("falls back to a first option that means 'no command' when the board's presets change under it", () => {
    const { rerender } = render(
      <SpawnPanel envs={envs} presets={[{ id: "p1", text: "/plan" }]} defaultPresetId="p1" hasSessions={false} onSpawn={vi.fn()} onSpawned={vi.fn()} />,
    );
    expect(getStartCommandSelect().value).toBe("p1");

    // Simulate the board's presets changing under an open modal (an SSE update) — "p1" is gone.
    rerender(
      <SpawnPanel envs={envs} presets={[{ id: "p2", text: "/other" }]} defaultPresetId="p1" hasSessions={false} onSpawn={vi.fn()} onSpawned={vi.fn()} />,
    );

    const select = getStartCommandSelect();
    expect(select.options[0]?.value).toBe(""); // the fallback react-dom will land on
    expect(select.selectedOptions).toHaveLength(1);
    expect(select.selectedOptions[0]?.textContent).toBe("no command");
    expect(select.value).toBe("");
  });

  it("keeps the hint text and the spawned startCommand in agreement with what the select displays", async () => {
    const onSpawn = vi.fn((_body: SpawnRequestBody) =>
      Promise.resolve({
        env: "local", paneId: "p1", tabId: "t1", tabLabel: "t", workspaceId: "w1",
        workspaceLabel: "w", name: "n", cwdSnapshot: "/", sessionId: null,
      }),
    );
    const { rerender } = render(
      <SpawnPanel envs={envs} presets={[{ id: "p1", text: "/plan" }]} defaultPresetId="p1" hasSessions={false} onSpawn={onSpawn} onSpawned={vi.fn()} />,
    );
    rerender(
      <SpawnPanel envs={envs} presets={[{ id: "p2", text: "/other" }]} defaultPresetId="p1" hasSessions={false} onSpawn={onSpawn} onSpawned={vi.fn()} />,
    );

    // The hint must match "no command" being displayed, not the stale preset's text.
    expect(screen.getByText(/^Edited in Board settings/)).toBeDefined();
    expect(screen.queryByText(/\/plan/)).toBeNull();

    await waitFor(() => { expect(screen.getByRole("button", { name: "Spawn" }).hasAttribute("disabled")).toBe(false); });
    fireEvent.click(screen.getByRole("button", { name: "Spawn" }));

    await waitFor(() => { expect(onSpawn).toHaveBeenCalledTimes(1); });
    const [body] = onSpawn.mock.calls[0] ?? [];
    expect(body).toBeDefined();
    if (body === undefined) return;
    // buildSpawnRequest omits startCommand entirely when there is none — it must not carry "/plan".
    expect(Object.prototype.hasOwnProperty.call(body, "startCommand")).toBe(false);
  });
});
