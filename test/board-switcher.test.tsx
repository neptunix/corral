// @vitest-environment jsdom
import type { BoardFrame } from "@shared/board-schema";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardSwitcher } from "../web/src/components/BoardSwitcher";
import { ThemeProvider } from "../web/src/components/ThemeProvider";
import { ZERO_COUNTS } from "../web/src/lib/attention";

afterEach(cleanup);

function board(id: string): BoardFrame {
  return { id, label: id, columns: [], tasks: [], spawnPresets: [], defaultSpawnPresetId: null };
}

describe("BoardSwitcher", () => {
  it("shows a board's blocked and finished badges inside its own tab", () => {
    render(
      <ThemeProvider>
        <BoardSwitcher
          boards={[board("A")]}
          activeBoardId="A"
          unassignedCount={0}
          attentionCounts={new Map([["A", { blocked: 1, finished: 2 }]])}
          unassignedAttentionCount={ZERO_COUNTS}
          showingUnassigned={false}
          onSelect={vi.fn()}
          onUnassigned={vi.fn()}
          onNewBoard={vi.fn()}
        />
      </ThemeProvider>,
    );
    const tab = screen.getByRole("button", { name: /^A/ });
    expect(tab.querySelector('[title="1 blocked on this board"]')).toBeTruthy();
    expect(tab.querySelector('[title="2 finished on this board"]')).toBeTruthy();
  });
});
