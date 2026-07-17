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
    paneRunFn: vi.fn().mockResolvedValue(undefined),
    paneGetFn: vi.fn().mockResolvedValue({ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", cwd: "/proj" }),
    workspaceCreateFn: vi.fn().mockResolvedValue("w1"),
    workspaceCloseFn: vi.fn().mockResolvedValue(undefined),
    tabCloseFn: vi.fn().mockResolvedValue(undefined),
    workspaceListFn: vi.fn().mockResolvedValue([{ workspace_id: "w1", label: "corral" }]),
    listPanesFn: vi.fn().mockResolvedValue([{ paneId: "w1:p1", cwd: "/proj" }]),
  };
}

describe("spawnSession — create new workspace", () => {
  it("creates at repoPath and runs spawnCommand in a `<slug>-a` tab", async () => {
    const fns = baseFns();
    const result = await spawnSession({
      env: localEnv, taskSlug: "my-task", cwd: "/fallback", repo: "corral",
      assignedPaneIds: new Set(), spawnCommand: "claude-personal",
      targetWorkspaceId: null, repoPath: "/repos/corral", ...fns,
    });
    expect(result.idempotent).toBe(false);
    expect(result.paneId).toBe("w1:p2");
    expect(result.tabLabel).toBe("my-task-a");
    expect(fns.workspaceCreateFn).toHaveBeenCalledWith(localEnv, "/repos/corral", "corral");
    expect(fns.tabCreateFn).toHaveBeenCalledWith(localEnv, "w1", "/repos/corral", "my-task-a");
    expect(fns.paneRunFn).toHaveBeenCalledWith(localEnv, "w1:p2", "claude-personal", undefined);
    // No idempotency scan on the create-new path (a fresh workspace has no tabs).
    expect(fns.listPanesFn).not.toHaveBeenCalled();
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
  it("re-creates the workspace at cwd when the stored workspaceId is gone", async () => {
    const runCalls: { paneId: string; text: string }[] = [];
    const wsCreateCalls: { cwd: string; label: string }[] = [];
    const tabCalls: { workspaceId: string; cwd: string }[] = [];
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
        return Promise.resolve("wNEW");
      },
      paneGetFn: (_e, p) => Promise.resolve({ paneId: p, tabId: "wNEW:t1", workspaceId: "wNEW", cwd: "/orig/cwd" }),
      tabCreateFn: (_e, workspaceId, cwd) => {
        tabCalls.push({ workspaceId, cwd });
        return Promise.resolve({ tabId: "wNEW:t1", paneId: "wNEW:p1" });
      },
      paneRunFn: (_e, paneId, text) => {
        runCalls.push({ paneId, text });
        return Promise.resolve();
      },
    });
    expect(wsCreateCalls).toEqual([{ cwd: "/orig/cwd", label: "my-task" }]);
    expect(tabCalls).toEqual([{ workspaceId: "wNEW", cwd: "/orig/cwd" }]);
    expect(runCalls).toEqual([{ paneId: "wNEW:p1", text: "claude --resume abc" }]);
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
  it("closes a created workspace when tabCreate fails", async () => {
    const fns = baseFns();
    fns.tabCreateFn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(spawnSession({
      env: localEnv, taskSlug: "t", cwd: "/x", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: null, repoPath: "/repos/corral", ...fns,
    })).rejects.toThrow(/tab create/);
    expect(fns.workspaceCloseFn).toHaveBeenCalledWith(localEnv, "w1");
  });

  it("closes the created tab + workspace when paneRun fails", async () => {
    const fns = baseFns();
    fns.paneRunFn = vi.fn().mockRejectedValue(new Error("nope"));
    await expect(spawnSession({
      env: localEnv, taskSlug: "t", cwd: "/x", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: null, repoPath: "/repos/corral", ...fns,
    })).rejects.toThrow(/pane run/);
    expect(fns.tabCloseFn).toHaveBeenCalledWith(localEnv, "w1:t2");
    expect(fns.workspaceCloseFn).toHaveBeenCalledWith(localEnv, "w1");
  });
});
