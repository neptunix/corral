// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnrichedSessionLink, EnrichedTask } from "../shared/board-schema";
import { TaskCard } from "../web/src/components/TaskCard";

afterEach(cleanup);

function link(overrides: Partial<EnrichedSessionLink>): EnrichedSessionLink {
  return {
    env: "work-local", paneId: "w1:p0", tabId: "t1", tabLabel: "wm-84-canon-implement",
    workspaceId: "w1", workspaceLabel: "corral", name: "wm-84-canon-implement", cwdSnapshot: "/repo",
    sessionId: "551754cc-ee7b-4b9f-a6a8-aa599f6eb6e3",
    live: { status: "idle", model: null, ctxPct: null, detached: false, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, claudeStatus: null, claudeName: null, waitingFor: null, remoteControl: null, registryStatus: null },
    ...overrides,
  };
}

describe("TaskCard — duplicate session links (server-bug safety net)", () => {
  it("collapses two links resolving to the same (env, paneId, sessionId) into one row", () => {
    const task: EnrichedTask = {
      id: "t1", title: "Weight Management Timeline", description: "", status: "todo", priority: null,
      createdAt: 0, updatedAt: 0, logCount: 0, lastLogAtMs: null,
      sessions: [
        link({}), // exact duplicate of itself below
        link({}),
        link({
          paneId: "w1:pS", tabLabel: "weight-management-timeline-a", name: "weight-management-timeline-a",
          sessionId: "ddf50429-0000-4000-8000-000000000000",
        }),
      ],
    };
    render(
      <TaskCard
        task={task}
        boardId="b1"
        onOpenLog={vi.fn()}
        onEdit={vi.fn()}
        onOpenSession={vi.fn()}
        onDetachSession={vi.fn()}
        onCloseSession={vi.fn()}
        onResumeSession={vi.fn()}
      />,
    );
    // shortId button is keyed 1:1 per rendered row — the duplicate link must render its row only once.
    expect(screen.getAllByTitle(/Claude session 551754cc-ee7b-4b9f-a6a8-aa599f6eb6e3/)).toHaveLength(1);
    expect(screen.getAllByTitle(/Claude session/)).toHaveLength(2); // the duplicate + the distinct session
  });
});

describe("TaskCard — which string a live row shows", () => {
  function renderOne(over: Partial<EnrichedSessionLink>): void {
    const task: EnrichedTask = {
      id: "t1", title: "T", description: "", status: "todo", priority: null,
      createdAt: 0, updatedAt: 0, logCount: 0, lastLogAtMs: null, sessions: [link(over)],
    };
    render(
      <TaskCard
        task={task}
        boardId="b1"
        onOpenLog={vi.fn()}
        onEdit={vi.fn()}
        onOpenSession={vi.fn()}
        onDetachSession={vi.fn()}
        onCloseSession={vi.fn()}
        onResumeSession={vi.fn()}
      />,
    );
  }

  // The reported bug's visible half: a /rename reaches the registry in seconds but the herdr tab only
  // on the next sweep, so a live card rendering the tab label shows the OLD name in between. The
  // server resolves which string `name` is (server/api.ts); the card just has to render it.
  it("renders the session name, not the tab label", () => {
    renderOne({ name: "renamed-by-user", tabLabel: "stale-tab-label" });
    expect(screen.getByText(/renamed-by-user/)).toBeTruthy();
    expect(screen.queryByText(/stale-tab-label/)).toBeNull();
  });

  it("still renders the name on the detached branch", () => {
    renderOne({ name: "gone-session", live: null });
    expect(screen.getByText(/gone-session/)).toBeTruthy();
  });
});
