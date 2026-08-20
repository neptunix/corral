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
  sessionId: null, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
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
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/fallback", repo: "corral",
      assignedPaneIds: new Set(), spawnCommand: "claude-personal",
      targetWorkspaceId: null, repoPath: "/repos/corral", ...fns,
    });
    expect(result.idempotent).toBe(false);
    expect(result.paneId).toBe("w1:p1");                  // the ROOT pane, not a second one
    expect(result.tabLabel).toBe("my-task-a");
    expect(fns.workspaceCreateFn).toHaveBeenCalledWith(localEnv, "/repos/corral", "corral");
    expect(fns.tabRenameFn).toHaveBeenCalledWith(localEnv, "w1:t1", "my-task-a"); // root tab renamed
    expect(fns.tabCreateFn).not.toHaveBeenCalled();       // no second tab → no empty leftover
    expect(fns.paneRunFn).toHaveBeenCalledWith(localEnv, "w1:p1", "claude-personal --name my-task-a", undefined);
    // No idempotency scan on the create-new path (a fresh workspace has no tabs to rejoin).
    expect(fns.listPanesFn).not.toHaveBeenCalled();
  });

  it("falls back to creating a tab when the workspace exposes no root pane (older herdr)", async () => {
    const fns = baseFns();
    fns.workspaceCreateFn = vi.fn().mockResolvedValue({ workspaceId: "w1", rootTabId: undefined, rootPaneId: undefined });
    const result = await spawnSession({
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/fallback", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: null, repoPath: "/repos/corral", ...fns,
    });
    expect(result.paneId).toBe("w1:p2");
    expect(fns.tabRenameFn).not.toHaveBeenCalled();
    expect(fns.tabCreateFn).toHaveBeenCalledWith(localEnv, "w1", "/repos/corral", "my-task-a");
  });

  it("throws when creating a new space with no repoPath", async () => {
    const fns = baseFns();
    await expect(spawnSession({
      env: localEnv, taskSlug: "t", sessionName: "t-a", cwd: "/x", repo: "corral",
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
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/x", repo: "corral",
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
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/x", repo: "corral",
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
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/x", repo: "corral",
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
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/orig/cwd", repo: null,
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
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/orig/cwd", repo: null,
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
      assignedPaneIds: new Set(), targetWorkspaceId: "w1", repoPath: null, sessionName: "my-task-b", ...fns,
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
      env: localEnv, taskSlug: "t", sessionName: "t-a", cwd: "/x", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: null, repoPath: "/repos/corral", ...fns,
    })).rejects.toThrow(/tab (create|rename)/);
    expect(fns.workspaceCloseFn).toHaveBeenCalledWith(localEnv, "w1");
  });

  it("closes the created workspace (which drops the root tab) when paneRun fails", async () => {
    const fns = baseFns();
    fns.paneRunFn = vi.fn().mockRejectedValue(new Error("nope"));
    await expect(spawnSession({
      env: localEnv, taskSlug: "t", sessionName: "t-a", cwd: "/x", repo: "corral",
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
      env: localEnv, taskSlug: "t", sessionName: "t-a", cwd: "/x", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: "w1", repoPath: null, ...fns,
    })).rejects.toThrow(/pane run/);
    expect(fns.tabCloseFn).toHaveBeenCalledWith(localEnv, "w1:t2"); // the tab we created in the existing ws
    expect(fns.workspaceCloseFn).not.toHaveBeenCalled();           // the joined workspace is left intact
  });
});

describe("spawnSession — launch flags", () => {
  it("names the session and the tab with the same string", async () => {
    const fns = baseFns();
    await spawnSession({
      env: localEnv, taskSlug: "my-task", cwd: "/proj", repo: "corral", assignedPaneIds: new Set(),
      targetWorkspaceId: null, repoPath: "/repos/corral",
      sessionName: "my-task-auth", ...fns,
    });
    expect(fns.paneRunFn).toHaveBeenCalledWith(localEnv, "w1:p1", "claude --name my-task-auth", undefined);
    expect(fns.tabRenameFn).toHaveBeenCalledWith(localEnv, "w1:t1", "my-task-auth");
  });

  it("adds --model when one is chosen", async () => {
    const fns = baseFns();
    await spawnSession({
      env: localEnv, taskSlug: "t", cwd: "/proj", repo: "corral", assignedPaneIds: new Set(),
      targetWorkspaceId: null, repoPath: "/repos/corral",
      sessionName: "t-a", model: "fable", ...fns,
    });
    expect(fns.paneRunFn).toHaveBeenCalledWith(localEnv, "w1:p1", "claude --name t-a --model fable", undefined);
  });

  // shell-quote BACKSLASH-escapes brackets; it does NOT wrap them in single quotes. Verified:
  //   node -e "console.log(require('shell-quote').quote(['claude-sonnet-5[1m]']))"
  //   → claude-sonnet-5\[1m\]
  // The brackets are glob characters, which is the whole reason the command goes through quote().
  it("escapes a model's [1m] context-window suffix", async () => {
    const fns = baseFns();
    await spawnSession({
      env: localEnv, taskSlug: "t", cwd: "/proj", repo: "corral", assignedPaneIds: new Set(),
      targetWorkspaceId: null, repoPath: "/repos/corral",
      sessionName: "t-a", model: "claude-sonnet-5[1m]", ...fns,
    });
    const cmd = (fns.paneRunFn as unknown as { mock: { calls: string[][] } }).mock.calls[0]![2]!;
    expect(cmd).toContain("--model claude-sonnet-5\\[1m\\]");
  });

  // --remote-control takes an OPTIONAL argument, so a bare flag before the positional brief would eat
  // the brief as the RC session name and start a session with no prompt (spec Findings). Passing the
  // name fills the slot — which is why no `--` separator is needed. Same string as --name, so the
  // session found on a phone carries the label of the card row it belongs to.
  it("passes the session name to --remote-control so it cannot swallow the brief", async () => {
    const fns = baseFns();
    await spawnSession({
      env: localEnv, taskSlug: "t", cwd: "/proj", repo: "corral", assignedPaneIds: new Set(),
      targetWorkspaceId: null, repoPath: "/repos/corral",
      sessionName: "t-mgr", remoteControl: true, briefPath: "/briefs/x.md", ...fns,
    });
    const cmd = (fns.paneRunFn as unknown as { mock: { calls: string[][] } }).mock.calls[0]![2]!;
    expect(cmd).toContain("--remote-control t-mgr");
    expect(cmd.indexOf("--remote-control t-mgr")).toBeLessThan(cmd.indexOf('"$(cat'));
    expect(cmd).toContain('"$(cat /briefs/x.md');
  });

  it("omits --remote-control unless it was asked for", async () => {
    const fns = baseFns();
    await spawnSession({
      env: localEnv, taskSlug: "t", cwd: "/proj", repo: "corral", assignedPaneIds: new Set(),
      targetWorkspaceId: null, repoPath: "/repos/corral",
      sessionName: "t-a", ...fns,
    });
    expect(fns.paneRunFn).toHaveBeenCalledWith(localEnv, "w1:p1", "claude --name t-a", undefined);
  });

  it("sends no flags at all on resume", async () => {
    const fns = baseFns();
    await spawnSession({
      env: localEnv, taskSlug: "t", cwd: "/proj", repo: "corral", assignedPaneIds: new Set(),
      targetWorkspaceId: null, repoPath: "/repos/corral",
      sessionName: "t-a", model: "opus", remoteControl: true, resumeSessionId: "u-1", ...fns,
    });
    expect(fns.paneRunFn).toHaveBeenCalledWith(localEnv, "w1:p1", "claude --resume u-1", undefined);
  });

  // Replaces "falls back to <slug>-a for the tab when no sessionName is given". That fallback was a
  // SECOND name source living here, which the route's fallback chain could not reach: the resume path
  // omitted the name when the stored one had nothing usable left, so a card titled without Latin
  // characters resumed as `task-a` whatever the route had decided. sessionName is now required and
  // spawn.ts derives nothing — this pins that the label is the route's string, untouched.
  it("labels the tab with the route's sessionName verbatim, deriving nothing from taskSlug", async () => {
    const fns = baseFns();
    const r = await spawnSession({
      env: localEnv, taskSlug: "my-task", sessionName: "wm-stake-anchor-repro",
      cwd: "/proj", repo: "corral", assignedPaneIds: new Set(),
      targetWorkspaceId: null, repoPath: "/repos/corral",
      ...fns,
    });
    expect(r.tabLabel).toBe("wm-stake-anchor-repro");
  });

  // The join path (targetWorkspaceId set) is what every named spawn from corral_spawn actually takes
  // (mcp/tools/session.ts sends targetWorkspaceId: me.session.workspaceId for a same-env handoff), so
  // sessionName needs its own coverage here — the tab is CREATED, not renamed, and tabName also drives
  // the idempotent-rejoin scan. A live `<slug>-a` tab must NOT be mistaken for this distinct session.
  it("creates the joined workspace's tab under the composed name, and does not rejoin <slug>-a", async () => {
    const fns = baseFns();
    fns.listPanesFn = vi.fn().mockResolvedValue([{ paneId: "w1:p9", cwd: "/proj" }]);
    fns.listFn = vi.fn().mockResolvedValue([makeRow("w1:p9", "my-task-a", "corral")]);
    const r = await spawnSession({
      env: localEnv, taskSlug: "my-task", cwd: "/x", repo: "corral", assignedPaneIds: new Set(),
      targetWorkspaceId: "w1", repoPath: null, sessionName: "my-task-rc-toggle-ui", ...fns,
    });
    expect(r.idempotent).toBe(false);
    expect(fns.tabCreateFn).toHaveBeenCalledWith(localEnv, "w1", "/proj", "my-task-rc-toggle-ui");
    expect(r.tabLabel).toBe("my-task-rc-toggle-ui");
  });
});

// targetWorkspaceId ABSENT (not null) + a repo: the caller named a repository rather than a space,
// so the workspace is looked up by that repository's name. An explicit null still creates and an id
// still joins — both covered above.
describe("spawnSession — resolve the workspace from the repo", () => {
  function resolveFns(spaces: { workspace_id: string; label: string }[]) {
    const fns = baseFns();
    return { ...fns, workspaceListStrictFn: vi.fn().mockResolvedValue(spaces) };
  }

  it("joins the space whose label matches the repo, compared case-insensitively", async () => {
    const fns = resolveFns([{ workspace_id: "w7", label: "Corral" }]);
    const r = await spawnSession({
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/elsewhere", repo: "corral",
      assignedPaneIds: new Set(), repoPath: "/repos/corral", ...fns,
    });
    expect(fns.workspaceCreateFn).not.toHaveBeenCalled();
    expect(r.workspaceLabel).toBe("Corral");
    expect(fns.tabCreateFn).toHaveBeenCalledWith(localEnv, "w7", "/repos/corral", "my-task-a");
  });

  // The name selects the WORKSPACE; the config selects the DIRECTORY. A space someone created at
  // another path can group the session oddly — it cannot land the new tab outside the repo root.
  it("roots the new tab at the configured path even when the matched space's panes sit elsewhere", async () => {
    const fns = resolveFns([{ workspace_id: "w7", label: "corral" }]);
    fns.listPanesFn = vi.fn().mockResolvedValue([{ paneId: "w7:p1", cwd: "/somewhere/unrelated" }]);
    await spawnSession({
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/elsewhere", repo: "corral",
      assignedPaneIds: new Set(), repoPath: "/repos/corral", ...fns,
    });
    expect(fns.tabCreateFn).toHaveBeenCalledWith(localEnv, "w7", "/repos/corral", "my-task-a");
  });

  it("creates the space at the configured path when no label matches", async () => {
    const fns = resolveFns([{ workspace_id: "w7", label: "other-project" }]);
    const r = await spawnSession({
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/elsewhere", repo: "corral",
      assignedPaneIds: new Set(), repoPath: "/repos/corral", ...fns,
    });
    expect(fns.workspaceCreateFn).toHaveBeenCalledWith(localEnv, "/repos/corral", "corral");
    expect(r.workspaceLabel).toBe("corral");
  });

  // Deterministic so a retry lands on the SAME duplicate and rejoins it, instead of starting a
  // second live session on the card.
  it("takes the lexicographically smallest workspace id when several spaces share the label", async () => {
    const fns = resolveFns([
      { workspace_id: "w9", label: "corral" },
      { workspace_id: "w2", label: "corral" },
    ]);
    await spawnSession({
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/elsewhere", repo: "corral",
      assignedPaneIds: new Set(), repoPath: "/repos/corral", ...fns,
    });
    expect(fns.tabCreateFn).toHaveBeenCalledWith(localEnv, "w2", "/repos/corral", "my-task-a");
  });

  // A colon is an ordinary map key character in environments.json "repos" — no parsing anywhere.
  it("matches a repo key containing a colon", async () => {
    const fns = resolveFns([{ workspace_id: "w7", label: "owner:project" }]);
    await spawnSession({
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/elsewhere", repo: "owner:project",
      assignedPaneIds: new Set(), repoPath: "/repos/project", ...fns,
    });
    expect(fns.workspaceCreateFn).not.toHaveBeenCalled();
    expect(fns.tabCreateFn).toHaveBeenCalledWith(localEnv, "w7", "/repos/project", "my-task-a");
  });

  // "Could not read the listing" must never be read as "no space carries this label" — that lands on
  // a duplicate create for a repository that may already have a workspace.
  it("refuses when the workspace listing fails instead of creating a second space", async () => {
    const fns = resolveFns([]);
    fns.workspaceListStrictFn = vi.fn().mockRejectedValue(new Error("herdr workspace list: unexpected shape"));
    await expect(spawnSession({
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/elsewhere", repo: "corral",
      assignedPaneIds: new Set(), repoPath: "/repos/corral", ...fns,
    })).rejects.toThrow(/unexpected shape/);
    expect(fns.workspaceCreateFn).not.toHaveBeenCalled();
  });

  // Same reason: an un-wired listing is a listing that failed, not an empty herdr.
  it("refuses when no strict listing function is wired at all", async () => {
    const fns = baseFns();
    await expect(spawnSession({
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/elsewhere", repo: "corral",
      assignedPaneIds: new Set(), repoPath: "/repos/corral", ...fns,
    })).rejects.toThrow(/workspaceListStrictFn/);
    expect(fns.workspaceCreateFn).not.toHaveBeenCalled();
  });

  it("rejoins a live tab of the same name inside the resolved space", async () => {
    const fns = resolveFns([{ workspace_id: "w7", label: "corral" }]);
    fns.listPanesFn = vi.fn().mockResolvedValue([{ paneId: "w7:p1", cwd: "/repos/corral" }]);
    fns.listFn = vi.fn().mockResolvedValue([makeRow("w7:p1", "my-task-a", "corral")]);
    fns.paneGetFn = vi.fn().mockResolvedValue({ paneId: "w7:p1", tabId: "w7:t1", workspaceId: "w7", cwd: "/repos/corral" });
    const r = await spawnSession({
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/elsewhere", repo: "corral",
      assignedPaneIds: new Set(), repoPath: "/repos/corral", ...fns,
    });
    expect(r.idempotent).toBe(true);
    expect(fns.tabCreateFn).not.toHaveBeenCalled();
  });
});

// The browser's "＋ <repo>" pick, at the layer that decides it. An explicit null is a CREATE even
// when a space with that label already exists — that is the case resolve-by-repo would have joined,
// and the route-level test cannot see the difference because it mocks the spawner.
describe("spawnSession — an explicit null target still creates", () => {
  it("creates a new space even when one already carries the repo's label", async () => {
    const fns = baseFns();
    const strict = vi.fn().mockResolvedValue([{ workspace_id: "w7", label: "corral" }]);
    await spawnSession({
      env: localEnv, taskSlug: "my-task", sessionName: "my-task-a", cwd: "/elsewhere", repo: "corral",
      assignedPaneIds: new Set(), targetWorkspaceId: null, repoPath: "/repos/corral",
      workspaceListStrictFn: strict, ...fns,
    });
    expect(fns.workspaceCreateFn).toHaveBeenCalledWith(localEnv, "/repos/corral", "corral");
    expect(strict).not.toHaveBeenCalled(); // the resolve path is not even consulted
  });
});
