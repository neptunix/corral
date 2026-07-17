import { DEFAULT_COLUMNS } from "@shared/board-schema";
import type { SessionRow, Snapshot } from "@shared/schema";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { Poller } from "../server/poller.ts";
import { startReconciler } from "../server/reconcile.ts";
import { createStorage } from "../server/storage.ts";

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "reconcile-test-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

// A poller stub whose snapshot and subscribers we drive by hand.
function fakePoller() {
  let snap: Snapshot = { envs: {}, sessions: [] };
  const subs = new Set<(s: Snapshot) => void>();
  const poller: Poller = {
    getSnapshot: () => snap,
    getAttention: () => ({}),
    onSnapshot: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    pollOnce: async () => {},
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    runClaudeSweepOnce: async () => {},
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    start: () => {},
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    stop: () => {},
  };
  return {
    poller,
    setSnapshot: (s: Snapshot) => { snap = s; },
    emit: () => { for (const cb of subs) cb(snap); },
  };
}

// Storage with a spied withBoard so we can assert whether a poll wrote anything (write-amplification).
// vi.spyOn (not a wrapping vi.fn) keeps `storage` typed as Storage and calls through to the real impl.
function makeStorage() {
  const storage = createStorage(tmpDir);
  const withBoard = vi.spyOn(storage, "withBoard");
  return { storage, withBoard };
}

async function seedLink(storage: ReturnType<typeof makeStorage>["storage"], sessionId: string | null): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await storage.withBoard("test", () => ({
    board: {
      id: "test", label: "Test", columns: [...DEFAULT_COLUMNS],
      tasks: [{
        id: "t_seeded", title: "T", description: "", status: "todo", priority: null, repo: null,
        sessions: [{ env: "work-local", paneId: "p1", tabId: "", tabLabel: "", workspaceId: "", workspaceLabel: "", name: "n", cwdSnapshot: "", sessionId }],
        createdAt: now, updatedAt: now,
      }],
    },
    result: undefined,
  }));
}

function rowWithId(sessionId: string): SessionRow {
  return { env: "work-local", paneId: "p1", status: "working", agent: "claude", cwd: "/r", tab: "t", workspace: "w", sessionId, recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null };
}

describe("startReconciler", () => {
  it("backfills a link's sessionId once the poller snapshot carries it (null → value)", async () => {
    const { storage } = makeStorage();
    await seedLink(storage, null);
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    fp.setSnapshot({ envs: {}, sessions: [rowWithId("uuid-1")] });
    fp.emit();

    await vi.waitFor(() => {
      expect(storage.getBoard("test")?.tasks[0]?.sessions[0]?.sessionId).toBe("uuid-1");
    });
  });

  it("does not write when every link already has its sessionId (no per-poll amplification)", async () => {
    const { storage, withBoard } = makeStorage();
    await seedLink(storage, "uuid-1");
    withBoard.mockClear(); // ignore the seed write
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    fp.setSnapshot({ envs: {}, sessions: [rowWithId("uuid-1")] });
    fp.emit();

    expect(withBoard).not.toHaveBeenCalled();
  });

  it("never overwrites an existing sessionId with a different live id", async () => {
    const { storage, withBoard } = makeStorage();
    await seedLink(storage, "uuid-A");
    withBoard.mockClear();
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    fp.setSnapshot({ envs: {}, sessions: [rowWithId("uuid-B")] });
    fp.emit();

    expect(withBoard).not.toHaveBeenCalled();
    expect(storage.getBoard("test")?.tasks[0]?.sessions[0]?.sessionId).toBe("uuid-A");
  });

  it("does nothing when the snapshot has no session ids to offer", () => {
    const { storage, withBoard } = makeStorage();
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    fp.setSnapshot({ envs: {}, sessions: [] });
    fp.emit();

    expect(withBoard).not.toHaveBeenCalled();
  });
});
