// @vitest-environment jsdom
import type { SessionRow } from "@shared/schema";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FinishedKeysContext } from "../web/src/components/AttentionMarks";
import { UnassignedView } from "../web/src/components/UnassignedView";

vi.mock("../web/src/lib/api", () => ({
  api: {
    sessions: {
      read: () => Promise.resolve({ text: "", ctxPct: null, model: null, sessionName: null }),
    },
  },
}));

afterEach(cleanup);

function row(paneId: string): SessionRow {
  return {
    env: "e1", paneId, status: "working", agent: "claude", cwd: "/pane-cwd", tab: "t", workspace: "w",
    sessionId: null, recap: null, recapAt: null, recapStatus: null, recapSource: null,
    statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null,
    remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
  };
}

async function renderView(sessions: SessionRow[], finished: ReadonlySet<string>): Promise<void> {
  await act(async () => {
    render(
      <FinishedKeysContext.Provider value={finished}>
        <UnassignedView
          sessions={sessions}
          boards={[]}
          envs={{}}
          onOpen={vi.fn()}
          onCreateTask={vi.fn()}
          onAssignTask={vi.fn()}
        />
      </FinishedKeysContext.Provider>,
    );
  });
}

describe("UnassignedView — finished mark", () => {
  it("shows a ✓ when the card's env:paneId is in FinishedKeysContext", async () => {
    await renderView([row("p1")], new Set(["e1:p1"]));
    expect(screen.getByTitle("Finished — not opened yet")).toBeTruthy();
  });

  it("shows no ✓ when the card's env:paneId is not in FinishedKeysContext", async () => {
    await renderView([row("p1")], new Set(["e1:other"]));
    expect(screen.queryByTitle("Finished — not opened yet")).toBeNull();
  });
});
