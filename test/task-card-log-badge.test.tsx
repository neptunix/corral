// @vitest-environment jsdom
import type { EnrichedSessionLink, EnrichedTask } from "@shared/board-schema";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskCard } from "../web/src/components/TaskCard";
import { markLogSeen } from "../web/src/lib/log-seen";

afterEach(() => { cleanup(); window.localStorage.clear(); });

const live: EnrichedSessionLink = {
  env: "env-a", paneId: "w1:p1", tabId: "t1", tabLabel: "worker-a", workspaceId: "w1", workspaceLabel: "repo",
  name: "worker-a", cwdSnapshot: "/repo", sessionId: null,
  live: { status: "idle", model: null, ctxPct: null, detached: false, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, claudeStatus: null, claudeName: null, waitingFor: null, remoteControl: null, registryStatus: null },
};

function task(over: Partial<EnrichedTask>): EnrichedTask {
  return { id: "t1", title: "Card", description: "", status: "c1", priority: null, sessions: [], createdAt: 0, updatedAt: 0, logCount: 0, noteCount: 0, lastLogAtMs: null, ...over };
}

function card(t: EnrichedTask, onOpenLog = vi.fn(), onEdit = vi.fn()): JSX.Element {
  return <TaskCard task={t} boardId="b1" onEdit={onEdit} onOpenLog={onOpenLog} onOpenSession={vi.fn()} onDetachSession={vi.fn()} onCloseSession={vi.fn()} onResumeSession={vi.fn()} />;
}

describe("TaskCard — log badge", () => {
  it("a card never opened here shows every entry as new", () => {
    render(card(task({ logCount: 9, noteCount: 0, lastLogAtMs: 5_000 })));
    expect(screen.getByText("9")).toBeTruthy();
    expect(screen.getByText("9 new")).toBeTruthy();
  });

  it("a card whose log this browser has displayed shows the count and no \"new\"", () => {
    markLogSeen("b1/t1", { count: 9, atMs: 5_000 });
    render(card(task({ logCount: 9, noteCount: 0, lastLogAtMs: 5_000 })));
    expect(screen.getByText("9")).toBeTruthy();
    expect(screen.queryByText(/new/)).toBeNull();
  });

  it("entries written since the last look count as new — and the mark is per card, not per board", () => {
    markLogSeen("b1/t1", { count: 6, atMs: 5_000 });
    markLogSeen("b1/t2", { count: 9, atMs: 9_000 });
    render(card(task({ logCount: 9, noteCount: 0, lastLogAtMs: 6_000 })));
    expect(screen.getByText("3 new")).toBeTruthy();
  });

  it("a session on the card and no note yet is the card-signal case: \"nothing written\" — lifecycle entries do not count as written", () => {
    render(card(task({ sessions: [live], logCount: 2, noteCount: 0, lastLogAtMs: 1 })));
    expect(screen.getByText("nothing written")).toBeTruthy();
    expect(screen.queryByText("2")).toBeNull();
  });

  it("one note lifts the warning even with lifecycle entries around it", () => {
    render(card(task({ sessions: [live], logCount: 3, noteCount: 1, lastLogAtMs: 1 })));
    expect(screen.queryByText("nothing written")).toBeNull();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("no session and lifecycle-only entries is a quiet count, not a warning — nobody is there to have written", () => {
    render(card(task({ logCount: 1, noteCount: 0, lastLogAtMs: 1 })));
    expect(screen.queryByText("nothing written")).toBeNull();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("no session and no log shows no badge at all", () => {
    render(card(task({})));
    expect(screen.queryByTestId("log-badge")).toBeNull();
  });

  it("clicking the badge opens the log, not the card's session or the edit form", () => {
    const onOpenLog = vi.fn();
    const onEdit = vi.fn();
    render(card(task({ logCount: 2, noteCount: 0, lastLogAtMs: 1 }), onOpenLog, onEdit));
    fireEvent.click(screen.getByTestId("log-badge"));
    expect(onOpenLog).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();
  });
});
