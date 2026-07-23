import { describe, it, expect } from "vitest";

import { ENVIRONMENTS } from "../environments.ts";
import type { ExecFn } from "../server/herdr.ts";
import { paneRun, paneGet, tabCreate, workspaceCreate, tabClose, tabRename, listPanes } from "../server/herdr.ts";

const env = ENVIRONMENTS[0]!;

function makeExec(stdout: string): ExecFn {
  // eslint-disable-next-line @typescript-eslint/require-await
  return async (_file, args) => {
    // capture the args to verify
    (makeExec as unknown as { lastArgs: readonly string[] }).lastArgs = args;
    return { stdout, stderr: "" };
  };
}

describe("paneRun", () => {
  it("calls pane run with text arg", async () => {
    const exec = makeExec("");
    await paneRun(env, "w1-1", "/rename my-task", exec);
    expect((makeExec as unknown as { lastArgs: string[] }).lastArgs).toContain("run");
    expect((makeExec as unknown as { lastArgs: string[] }).lastArgs).toContain("w1-1");
  });
});

describe("paneGet", () => {
  it("parses pane_id, tab_id, workspace_id, cwd", async () => {
    const payload = JSON.stringify({
      result: {
        pane: {
          pane_id: "w1-1", tab_id: "t1", workspace_id: "ws1",
          cwd: "/home/me/project", foreground_cwd: "/home/me/project",
          agent: "claude", agent_status: "idle", focused: false, revision: 0,
          terminal_id: "term_1",
        },
        type: "pane_info",
      },
    });
    const exec = makeExec(payload);
    const result = await paneGet(env, "w1-1", exec);
    expect(result.tabId).toBe("t1");
    expect(result.workspaceId).toBe("ws1");
    expect(result.cwd).toBe("/home/me/project");
  });
});

describe("tabCreate (herdr 0.7.1 nested shape)", () => {
  it("returns {tabId, paneId} from result.tab / result.root_pane", async () => {
    const payload = JSON.stringify({
      result: {
        tab: { tab_id: "w8:t2", label: "probe-tab", workspace_id: "w8" },
        root_pane: { pane_id: "w8:p2", cwd: "/proj", tab_id: "w8:t2", workspace_id: "w8" },
        type: "tab_created",
      },
    });
    const out = await tabCreate(env, "w8", "/proj", "my-task", makeExec(payload));
    expect(out).toEqual({ tabId: "w8:t2", paneId: "w8:p2" });
  });

  it("falls back to flat tab_id/pane_id", async () => {
    const payload = JSON.stringify({ result: { tab_id: "t2", pane_id: "p2" } });
    const out = await tabCreate(env, "ws1", "/proj", "my-task", makeExec(payload));
    expect(out).toEqual({ tabId: "t2", paneId: "p2" });
  });

  it("throws when neither shape yields ids", async () => {
    await expect(tabCreate(env, "ws1", "/proj", "t", makeExec(JSON.stringify({ result: {} })))).rejects.toThrow(/tab create/);
  });
});

describe("workspaceCreate (herdr 0.7.1 nested shape)", () => {
  it("reads result.workspace.workspace_id + the root_pane ids (so spawn can reuse the root tab)", async () => {
    const payload = JSON.stringify({ result: { workspace: { workspace_id: "w8", label: "corral" }, root_pane: { pane_id: "w8:p1", tab_id: "w8:t1" } } });
    expect(await workspaceCreate(env, "/proj", "corral", makeExec(payload))).toEqual({ workspaceId: "w8", rootTabId: "w8:t1", rootPaneId: "w8:p1" });
  });

  it("falls back to flat result.workspace_id with no root ids (older herdr → spawn creates a tab)", async () => {
    expect(await workspaceCreate(env, "/proj", "w", makeExec(JSON.stringify({ result: { workspace_id: "ws2" } })))).toEqual({ workspaceId: "ws2", rootTabId: undefined, rootPaneId: undefined });
  });
});

describe("listPanes", () => {
  it("returns {paneId, cwd} per pane in a workspace", async () => {
    const payload = JSON.stringify({ result: { panes: [{ pane_id: "w:p2", cwd: "/proj", tab_id: "w:t2", workspace_id: "w" }], type: "pane_list" } });
    expect(await listPanes(env, "w", makeExec(payload))).toEqual([{ paneId: "w:p2", cwd: "/proj" }]);
  });

  it("returns [] on an unexpected shape", async () => {
    expect(await listPanes(env, "w", makeExec("{}"))).toEqual([]);
  });
});

describe("tabClose", () => {
  it("calls tab close with tabId", async () => {
    const exec = makeExec("");
    await tabClose(env, "t1", exec);
    expect((makeExec as unknown as { lastArgs: string[] }).lastArgs).toContain("close");
    expect((makeExec as unknown as { lastArgs: string[] }).lastArgs).toContain("t1");
  });
});

describe("tabRename", () => {
  it("calls tab rename with tabId and label", async () => {
    const exec = makeExec("");
    await tabRename(env, "t1", "my label", exec);
    const args = (makeExec as unknown as { lastArgs: string[] }).lastArgs;
    expect(args).toEqual(["tab", "rename", "t1", "my label"]);
  });
});
