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
  refreshEnv: async () => {},
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    runClaudeSweepOnce: async () => {},
    applyRegistry: () => undefined,
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
        id: "t_seeded", title: "T", description: "", status: "todo", priority: null,
        sessions: [{ env: "work-local", paneId: "p1", tabId: "", tabLabel: "", workspaceId: "", workspaceLabel: "", name: "n", cwdSnapshot: "", sessionId }],
        createdAt: now, updatedAt: now, log: [],
      }],
      spawnPresets: [], defaultSpawnPresetId: null,
    },
    result: undefined,
  }));
}

function rowWithId(sessionId: string): SessionRow {
  return { env: "work-local", paneId: "p1", status: "working", agent: "claude", cwd: "/r", tab: "t", workspace: "w", sessionId, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null };
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

// A live row carrying a name the mirror may or may not copy, per its provenance gate.
function namedRow(sessionId: string, claudeName: string | null, claudeNameUserSet: boolean | null, paneId = "p1"): SessionRow {
  return { ...rowWithId(sessionId), paneId, claudeName, claudeNameUserSet };
}

const storedName = (storage: ReturnType<typeof makeStorage>["storage"]): string | undefined =>
  storage.getBoard("test")?.tasks[0]?.sessions[0]?.name;

describe("startReconciler — the SessionLink name mirror", () => {
  it("rewrites link.name when the live row carries a changed user-set name", async () => {
    const { storage } = makeStorage();
    await seedLink(storage, "uuid-1");
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    fp.setSnapshot({ envs: {}, sessions: [namedRow("uuid-1", "Fix the auth bug", true)] });
    fp.emit();

    await vi.waitFor(() => { expect(storedName(storage)).toBe("Fix the auth bug"); });
  });

  it("opens NO board for a derived name — asserted as zero writes, not as an unchanged name", async () => {
    const { storage, withBoard } = makeStorage();
    await seedLink(storage, "uuid-1");
    withBoard.mockClear();
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    // The weaker "name is unchanged" form passes against a pre-scan looser than the write rule.
    for (let i = 0; i < 3; i++) {
      fp.setSnapshot({ envs: {}, sessions: [namedRow("uuid-1", "corral-a1b2", false)] });
      fp.emit();
    }

    expect(withBoard).not.toHaveBeenCalled();
    expect(storedName(storage)).toBe("n");
  });

  it("opens NO board for a name that normalizes to empty, and leaves the stored name intact", async () => {
    const { storage, withBoard } = makeStorage();
    await seedLink(storage, "uuid-1");
    withBoard.mockClear();
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    for (let i = 0; i < 3; i++) {
      fp.setSnapshot({ envs: {}, sessions: [namedRow("uuid-1", "   ", true)] });
      fp.emit();
    }

    // "" is the one value server/api.ts says must never be stored — a detached card renders a bare warning.
    expect(withBoard).not.toHaveBeenCalled();
    expect(storedName(storage)).toBe("n");
  });

  it("CONVERGES on a name that normalization alters — one write, then none", async () => {
    const { storage, withBoard } = makeStorage();
    await seedLink(storage, "uuid-1");
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    fp.setSnapshot({ envs: {}, sessions: [namedRow("uuid-1", "renamed\n", true)] });
    fp.emit();
    await vi.waitFor(() => { expect(storedName(storage)).toBe("renamed"); });

    // An implementation that compares the RAW name and writes the normalized one never converges:
    // the stored value differs forever and the board is rewritten every tick.
    withBoard.mockClear();
    for (let i = 0; i < 3; i++) fp.emit();
    expect(withBoard).not.toHaveBeenCalled();
  });

  it("writes nothing once a link is already mirrored", async () => {
    const { storage, withBoard } = makeStorage();
    await seedLink(storage, "uuid-1");
    withBoard.mockClear();
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    for (let i = 0; i < 3; i++) {
      fp.setSnapshot({ envs: {}, sessions: [namedRow("uuid-1", "n", true)] });
      fp.emit();
    }
    expect(withBoard).not.toHaveBeenCalled();
  });

  it("never clears a stored name when the row resolves to no name", async () => {
    const { storage, withBoard } = makeStorage();
    await seedLink(storage, "uuid-1");
    withBoard.mockClear();
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    fp.setSnapshot({ envs: {}, sessions: [namedRow("uuid-1", null, null)] });
    fp.emit();

    expect(withBoard).not.toHaveBeenCalled();
    expect(storedName(storage)).toBe("n");
  });

  it("resolves by sessionId, so a pane reused by a stranger does not rename the card", async () => {
    const { storage, withBoard } = makeStorage();
    await seedLink(storage, "uuid-MINE");
    withBoard.mockClear();
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    // herdr recycled p1 onto a different session, which carries its own user-set name.
    fp.setSnapshot({ envs: {}, sessions: [namedRow("uuid-STRANGER", "stranger work", true)] });
    fp.emit();

    expect(withBoard).not.toHaveBeenCalled();
    expect(storedName(storage)).toBe("n");
  });

  it("skips a link whose sessionId is the empty string, rather than resolving it by paneId", async () => {
    const { storage, withBoard } = makeStorage();
    await seedLink(storage, "");
    withBoard.mockClear();
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    // A non-null test alone would pass "" through, and resolveLiveRow would fall back to the paneId hit.
    fp.setSnapshot({ envs: {}, sessions: [namedRow("uuid-OTHER", "stranger work", true)] });
    fp.emit();

    await vi.waitFor(() => { expect(storage.getBoard("test")?.tasks[0]?.sessions[0]?.sessionId).toBe("uuid-OTHER"); });
    expect(storedName(storage)).toBe("n");
  });

  it("picks the name up on the first pass after a null sessionId is backfilled", async () => {
    const { storage } = makeStorage();
    await seedLink(storage, null);
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    fp.setSnapshot({ envs: {}, sessions: [namedRow("uuid-1", "Fix the auth bug", true)] });
    fp.emit();
    await vi.waitFor(() => { expect(storage.getBoard("test")?.tasks[0]?.sessions[0]?.sessionId).toBe("uuid-1"); });

    // The mirror is level-triggered: it re-proposes on the next snapshot rather than losing the rename.
    fp.emit();
    await vi.waitFor(() => { expect(storedName(storage)).toBe("Fix the auth bug"); });
  });

  it("writes a board needing a backfill on one link and a mirror on another exactly once", async () => {
    const { storage, withBoard } = makeStorage();
    // Two links on one board: p1 is already bound and due a rename, p2 still needs its id.
    const now = Math.floor(Date.now() / 1000);
    const link = (paneId: string, sessionId: string | null) => ({
      env: "work-local", paneId, tabId: "", tabLabel: "", workspaceId: "", workspaceLabel: "",
      name: "n", cwdSnapshot: "", sessionId,
    });
    await storage.withBoard("test", () => ({
      board: {
        id: "test", label: "Test", columns: [...DEFAULT_COLUMNS],
        tasks: [{
          id: "t_seeded", title: "T", description: "", status: "todo", priority: null,
          sessions: [link("p1", "uuid-1"), link("p2", null)],
          createdAt: now, updatedAt: now, log: [],
        }],
        spawnPresets: [], defaultSpawnPresetId: null,
      },
      result: undefined,
    }));
    withBoard.mockClear();
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    fp.setSnapshot({ envs: {}, sessions: [
      namedRow("uuid-1", "Fix the auth bug", true, "p1"),
      namedRow("uuid-2", null, null, "p2"),
    ] });
    fp.emit();

    await vi.waitFor(() => {
      const links = storage.getBoard("test")?.tasks[0]?.sessions;
      expect(links?.[0]?.name).toBe("Fix the auth bug");
      expect(links?.[1]?.sessionId).toBe("uuid-2");
    });
    // Two transactions would re-read, re-serialize and rewrite the same file twice.
    expect(withBoard).toHaveBeenCalledTimes(1);
  });

  it("mirrors a freshly backfilled link on the NEXT snapshot, not the one that bound it", async () => {
    const { storage, withBoard } = makeStorage();
    await seedLink(storage, null);
    withBoard.mockClear();
    const fp = fakePoller();
    startReconciler({ poller: fp.poller, storage });

    // Same tick: the backfill decided this pane is uuid-1 by paneId alone. Renaming off that decision
    // in the same pass would inherit the poisoning caveat the backfill accepts only because it is a
    // one-shot write.
    fp.setSnapshot({ envs: {}, sessions: [namedRow("uuid-1", "Fix the auth bug", true)] });
    fp.emit();
    await vi.waitFor(() => { expect(storage.getBoard("test")?.tasks[0]?.sessions[0]?.sessionId).toBe("uuid-1"); });
    expect(storedName(storage)).toBe("n");

    fp.emit();
    await vi.waitFor(() => { expect(storedName(storage)).toBe("Fix the auth bug"); });
  });
});
