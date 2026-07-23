import type { SessionRow } from "@shared/schema";
import { describe, expect, it, vi } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { spawnSession } from "../server/spawn.ts";

const localEnv: HerdrEnv = {
  id: "work-local", label: "Work (local)", kind: "local",
  claudeConfigDirs: [], spawnCommand: "claude", repos: {},
};

const makeRow = (paneId: string, tab: string, workspace: string): SessionRow => ({
  env: "work-local", paneId, status: "idle", agent: "claude",
  cwd: "/proj", tab, workspace,
  sessionId: null, recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null,
});

function baseFns() {
  return {
    listFn: vi.fn().mockResolvedValue([]),
    tabCreateFn: vi.fn().mockResolvedValue({ tabId: "w1:t2", paneId: "w1:p2" }),
    tabRenameFn: vi.fn().mockResolvedValue(undefined),
    paneRunFn: vi.fn().mockResolvedValue(undefined),
    paneGetFn: vi.fn().mockResolvedValue({ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", cwd: "/proj" }),
    // workspace create seeds a root tab + pane; spawn reuses that tab rather than leaving it empty.
    workspaceCreateFn: vi.fn().mockResolvedValue({ workspaceId: "w1", rootTabId: "w1:t1", rootPaneId: "w1:p1" }),
    workspaceCloseFn: vi.fn().mockResolvedValue(undefined),
    tabCloseFn: vi.fn().mockResolvedValue(undefined),
    workspaceListFn: vi.fn().mockResolvedValue([{ workspace_id: "w1", label: "corral" }]),
    listPanesFn: vi.fn().mockResolvedValue([{ paneId: "w1:p1", cwd: "/proj" }]),
  };
}

describe("spawnSession — create new workspace", () => {
  it("reuses the workspace's root tab (renames it) instead of leaving it empty", async () => {
    const fns = baseFns();
    fns.paneGetFn = vi.fn().mockResolvedValue({ paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", cwd: "/repos/corral" });
    const result = await spawnSession({
      env: localEnv, taskSlug: "my-task", cwd: "/fallback", repo: "corral",
      assignedPaneIds: new Set(), spawnCommand: "claude-personal",
      targetWorkspaceId: null, repoPath: "/repos/corral", ...fns,
    });
    expect(result.idempotent).toBe(false);
    expect(result.paneId).toBe("w1:p1");                  // the ROOT pane, not a second one
    expect(result.tabLabel).toBe("my-task-a");
    expect(fns.workspaceCreateFn).toHaveBeenCalledWith(localEnv, "/repos/corral", "corral");
    expect(fns.tabRenameFn).toHaveBeenCalledWith(localEnv, "w1:t1", "my-task-a"); // root tab renamed
    expect(fns.tabCreateFn).not.toHaveBeenCalled();       // no second tab → no empty leftover
    expect(fns.paneRunFn).toHaveBeenCalledWith(localEnv, "w1:p1", "claude-personal", undefined);
    // No idempotency scan on the create-new path (a fresh workspace has no tabs to rejoin).
    expect(fns.listPanesFn).not.toHaveBeenCalled();
  });

  it("falls back to creating a tab when the workspace exposes no root pane (older herdr)", async () => {
    const fns = baseFns();
    fns.workspaceCreateFn = vi.fn().mockResolvedValue({ workspaceId: "w1", rootTabId: undefined, rootPaneId: undefined });
    const result = await spawnSession({
      env: localEnv, taskSlug: "my-task", cwd: "/fallback", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: null, repoPath: "/repos/corral", ...fns,
    });
    expect(result.paneId).toBe("w1:p2");
    expect(fns.tabRenameFn).not.toHaveBeenCalled();
    expect(fns.tabCreateFn).toHaveBeenCalledWith(localEnv, "w1", "/repos/corral", "my-task-a");
  });

  it("throws when creating a new space with no repoPath", async () => {
    const fns = baseFns();
    await expect(spawnSession({
      env: localEnv, taskSlug: "t", cwd: "/x", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: null, repoPath: null, ...fns,
    })).rejects.toThrow(/no path configured for repo "corral"/);
    expect(fns.workspaceCreateFn).not.toHaveBeenCalled();
  });
});

describe("spawnSession — join existing workspace", () => {
  it("uses the chosen workspace and resolves cwd from its pane", async () => {
    const fns = baseFns();
    fns.listPanesFn = vi.fn().mockResolvedValue([{ paneId: "w1:p1", cwd: "/existing/corral" }]);
    const result = await spawnSession({
      env: localEnv, taskSlug: "my-task", cwd: "/x", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: "w1", repoPath: "/ignored", ...fns,
    });
    expect(fns.workspaceCreateFn).not.toHaveBeenCalled();
    expect(fns.tabCreateFn).toHaveBeenCalledWith(localEnv, "w1", "/existing/corral", "my-task-a");
    expect(result.workspaceId).toBe("w1");
  });
});

describe("spawnSession — idempotency (scoped to the joined workspace by pane membership)", () => {
  it("returns the existing `<slug>-a` tab living IN the joined workspace", async () => {
    const fns = baseFns();
    // the existing pane must be a member of the joined workspace (id-scoped, not label-scoped)
    fns.listPanesFn = vi.fn().mockResolvedValue([{ paneId: "w1:p9", cwd: "/proj" }]);
    fns.listFn = vi.fn().mockResolvedValue([makeRow("w1:p9", "my-task-a", "corral")]);
    fns.paneGetFn = vi.fn().mockResolvedValue({ paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", cwd: "/proj" });
    const result = await spawnSession({
      env: localEnv, taskSlug: "my-task", cwd: "/x", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: "w1", repoPath: null, ...fns,
    });
    expect(result.idempotent).toBe(true);
    expect(result.paneId).toBe("w1:p9");
    expect(result.tabLabel).toBe("my-task-a");
    expect(fns.tabCreateFn).not.toHaveBeenCalled();
  });

  it("does NOT match a same-labeled tab whose pane is in a different workspace", async () => {
    const fns = baseFns();
    // pane list for the joined workspace does NOT contain the matching session's pane
    fns.listPanesFn = vi.fn().mockResolvedValue([{ paneId: "w1:p1", cwd: "/proj" }]);
    fns.listFn = vi.fn().mockResolvedValue([makeRow("wOTHER:p9", "my-task-a", "corral")]);
    const result = await spawnSession({
      env: localEnv, taskSlug: "my-task", cwd: "/x", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: "w1", repoPath: null, ...fns,
    });
    expect(result.idempotent).toBe(false);
    expect(fns.tabCreateFn).toHaveBeenCalled();
  });
});

describe("spawnSession — resume mode", () => {
  it("resume mode: runs --resume <uuid>, uses cwd for the tab, skips rejoin scan", async () => {
    const runCalls: { paneId: string; text: string }[] = [];
    const tabCalls: { cwd: string; label: string }[] = [];
    const result = await spawnSession({
      env: localEnv, taskSlug: "my-task", cwd: "/orig/cwd", repo: null,
      assignedPaneIds: new Set(),
      spawnCommand: "claude",
      targetWorkspaceId: "w7",
      resumeSessionId: "abc",
      listFn: () => Promise.resolve([]),
      listPanesFn: () => Promise.resolve([{ paneId: "w7:p1", cwd: "/other" }]),
      workspaceListFn: () => Promise.resolve([{ workspace_id: "w7", label: "corral" }]),
      paneGetFn: (_e, p) => Promise.resolve({ paneId: p, tabId: "w7:t2", workspaceId: "w7", cwd: "/orig/cwd" }),
      tabCreateFn: (_e, _w, cwd, label) => {
        tabCalls.push({ cwd, label });
        return Promise.resolve({ tabId: "w7:t2", paneId: "w7:p9" });
      },
      paneRunFn: (_e, paneId, text) => {
        runCalls.push({ paneId, text });
        return Promise.resolve();
      },
    });
    expect(runCalls).toEqual([{ paneId: "w7:p9", text: "claude --resume abc" }]);
    expect(tabCalls[0]?.cwd).toBe("/orig/cwd");           // cwd forced from opts.cwd, not panes[0].cwd
    expect(result.idempotent).toBe(false);                // rejoin scan skipped
  });

  // A stored workspaceId is ephemeral: closing the space (or a herdr restart reassigning ids) leaves
  // the link pointing at a dead id, and `tab create --workspace <dead>` fails `workspace_not_found`.
  // Resume must re-create the space at cwdSnapshot instead — `claude --resume` is cwd-scoped, so the
  // transcript is still reachable from that path. Note repo is null here (the real-world case), so the
  // create-new branch's repoPath requirement must NOT apply on the resume path.
  it("re-creates the workspace at cwd when the stored workspaceId is gone, reusing its root tab", async () => {
    const runCalls: { paneId: string; text: string }[] = [];
    const wsCreateCalls: { cwd: string; label: string }[] = [];
    const renameCalls: { tabId: string; label: string }[] = [];
    const tabCreateFn = vi.fn();
    const result = await spawnSession({
      env: localEnv, taskSlug: "my-task", cwd: "/orig/cwd", repo: null,
      assignedPaneIds: new Set(),
      spawnCommand: "claude",
      targetWorkspaceId: "wJ",       // closed since the link was stored
      repoPath: null,                // task has no repo — only cwdSnapshot is known
      resumeSessionId: "abc",
      listFn: () => Promise.resolve([]),
      listPanesFn: () => Promise.resolve([]),
      workspaceListFn: () => Promise.resolve([{ workspace_id: "wOTHER", label: "corral" }]),
      workspaceCreateFn: (_e, cwd, label) => {
        wsCreateCalls.push({ cwd, label });
        return Promise.resolve({ workspaceId: "wNEW", rootTabId: "wNEW:t1", rootPaneId: "wNEW:p1" });
      },
      tabRenameFn: (_e, tabId, label) => { renameCalls.push({ tabId, label }); return Promise.resolve(); },
      tabCreateFn,
      paneGetFn: (_e, p) => Promise.resolve({ paneId: p, tabId: "wNEW:t1", workspaceId: "wNEW", cwd: "/orig/cwd" }),
      paneRunFn: (_e, paneId, text) => {
        runCalls.push({ paneId, text });
        return Promise.resolve();
      },
    });
    expect(wsCreateCalls).toEqual([{ cwd: "/orig/cwd", label: "my-task" }]);
    expect(renameCalls).toEqual([{ tabId: "wNEW:t1", label: "my-task-a" }]);
    expect(tabCreateFn).not.toHaveBeenCalled();            // root tab reused, none created
    expect(runCalls).toEqual([{ paneId: "wNEW:p1", text: "claude --resume abc" }]); // root pane
    expect(result.workspaceId).toBe("wNEW");
  });
});

describe("spawnSession — session suffix (Nth session)", () => {
  it("names the tab with the given suffix and does NOT rejoin a different suffix's tab", async () => {
    const fns = baseFns();
    // A live `my-task-a` tab lives in the joined workspace, but we're spawning suffix "b": it must not
    // rejoin `-a` — a distinct `my-task-b` tab is created.
    fns.listPanesFn = vi.fn().mockResolvedValue([{ paneId: "w1:p9", cwd: "/proj" }]);
    fns.listFn = vi.fn().mockResolvedValue([makeRow("w1:p9", "my-task-a", "corral")]);
    const result = await spawnSession({
      env: localEnv, taskSlug: "my-task", cwd: "/x", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: "w1", repoPath: null, sessionSuffix: "b", ...fns,
    });
    expect(result.idempotent).toBe(false);
    expect(fns.tabCreateFn).toHaveBeenCalledWith(localEnv, "w1", "/proj", "my-task-b");
    expect(result.tabLabel).toBe("my-task-b");
  });
});

describe("spawnSession — cleanup on failure", () => {
  it("closes a created workspace when the root-tab rename fails", async () => {
    const fns = baseFns();
    fns.tabRenameFn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(spawnSession({
      env: localEnv, taskSlug: "t", cwd: "/x", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: null, repoPath: "/repos/corral", ...fns,
    })).rejects.toThrow(/tab (create|rename)/);
    expect(fns.workspaceCloseFn).toHaveBeenCalledWith(localEnv, "w1");
  });

  it("closes the created workspace (which drops the root tab) when paneRun fails", async () => {
    const fns = baseFns();
    fns.paneRunFn = vi.fn().mockRejectedValue(new Error("nope"));
    await expect(spawnSession({
      env: localEnv, taskSlug: "t", cwd: "/x", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: null, repoPath: "/repos/corral", ...fns,
    })).rejects.toThrow(/pane run/);
    // We reused the root tab, so closing the workspace is the cleanup — no separate tab close.
    expect(fns.tabCloseFn).not.toHaveBeenCalled();
    expect(fns.workspaceCloseFn).toHaveBeenCalledWith(localEnv, "w1");
  });

  it("closes only the created tab (never the user's workspace) when paneRun fails on the join path", async () => {
    const fns = baseFns();
    fns.listPanesFn = vi.fn().mockResolvedValue([{ paneId: "w1:p1", cwd: "/proj" }]);
    fns.paneRunFn = vi.fn().mockRejectedValue(new Error("nope"));
    await expect(spawnSession({
      env: localEnv, taskSlug: "t", cwd: "/x", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: "w1", repoPath: null, ...fns,
    })).rejects.toThrow(/pane run/);
    expect(fns.tabCloseFn).toHaveBeenCalledWith(localEnv, "w1:t2"); // the tab we created in the existing ws
    expect(fns.workspaceCloseFn).not.toHaveBeenCalled();           // the joined workspace is left intact
  });
});
