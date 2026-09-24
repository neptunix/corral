// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnrichedSessionLink, EnrichedTask } from "../shared/board-schema";
import { TaskCard } from "../web/src/components/TaskCard";
import { FOLD_MIN_CLOSED } from "../web/src/lib/session-tree";

afterEach(cleanup);

function link(name: string, detached: boolean, spawnedBy?: EnrichedSessionLink["spawnedBy"]): EnrichedSessionLink {
  return {
    env: "e1", paneId: `p-${name}`, tabId: "t1", tabLabel: name, workspaceId: "w1", workspaceLabel: "ws",
    name, cwdSnapshot: "/repo/path", sessionId: `sid-${name}`,
    ...(spawnedBy === undefined ? {} : { spawnedBy }),
    live: { status: "idle", model: null, ctxPct: null, detached, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, claudeStatus: null, claudeName: null, waitingFor: null, remoteControl: null, registryStatus: null },
  };
}

function renderCard(sessions: EnrichedSessionLink[]): void {
  const task: EnrichedTask = {
    id: "t1", title: "T", description: "", status: "todo", priority: null,
    createdAt: 0, updatedAt: 0, logCount: 0, noteCount: 0, lastLogAtMs: null, sessions,
  };
  render(
    <TaskCard task={task} boardId="b1" onOpenLog={vi.fn()} onEdit={vi.fn()} onOpenSession={vi.fn()}
      onDetachSession={vi.fn()} onCloseSession={vi.fn()} onResumeSession={vi.fn()} />,
  );
}

describe("TaskCard — session tree and folded closed sessions", () => {
  const closed = Array.from({ length: FOLD_MIN_CLOSED }, (_, i) => link(`old-${String(i)}`, true));

  it("folds closed sessions into one strip and keeps live ones visible", () => {
    renderCard([link("live", false), ...closed]);
    expect(screen.getByTitle(/Claude session sid-live/)).toBeTruthy();
    expect(screen.queryByTitle(/Claude session sid-old-0/)).toBeNull();
    expect(screen.getByTitle(`${String(FOLD_MIN_CLOSED)} closed — click to show`)).toBeTruthy();
  });

  it("expands on click and folds back", () => {
    renderCard([link("live", false), ...closed]);
    fireEvent.click(screen.getByTitle(/closed — click to show/));
    expect(screen.getByTitle(/Claude session sid-old-0/)).toBeTruthy();
    fireEvent.click(screen.getByTitle("Hide closed sessions"));
    expect(screen.queryByTitle(/Claude session sid-old-0/)).toBeNull();
  });

  it("keeps a live child visible under a closed parent while the rest fold", () => {
    const parent = link("parent", true);
    const kid = link("kid", false, { sessionId: "sid-parent", env: "e1", paneId: "p-parent" });
    renderCard([parent, kid, ...closed]);
    expect(screen.getByTitle(/Claude session sid-parent/)).toBeTruthy();
    expect(screen.getByTitle(/Claude session sid-kid/)).toBeTruthy();
    expect(screen.queryByTitle(/Claude session sid-old-0/)).toBeNull();
  });

  it("shows no warning sign on a closed row", () => {
    renderCard([link("gone", true)]);
    expect(screen.queryByText(/⚠/)).toBeNull();
  });
});
