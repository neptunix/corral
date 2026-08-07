import { describe, it, expect, vi } from "vitest";

import { ENVIRONMENTS, getEnv } from "../environments.ts";
import type { ExecFn } from "../server/herdr.ts";
import { paneRun, paneGet, tabCreate, workspaceCreate, tabClose, tabRename, listPanes, listAllPanes } from "../server/herdr.ts";

const env = ENVIRONMENTS[0]!;

function makeExec(stdout: string): ExecFn {
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

describe("listAllPanes", () => {
  it("parses identity and marks a pane running an agent as occupied", async () => {
    const payload = JSON.stringify({
      result: {
        panes: [{
          agent: "claude",
          agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
          agent_status: "done",
          cwd: "/proj", pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1",
        }],
      },
    });
    expect(await listAllPanes(env, makeExec(payload))).toEqual([
      { paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: true },
    ]);
  });

  it("marks a pane with no agent, no agent_session and unknown status as agentless", async () => {
    // KNOWN BLIND SPOT — this same input is also what an OCCUPIED pane looks like. Verified against a
    // live herdr, `herdr agent start <name> -- bash` yields a pane list entry with no `agent`, no
    // `agent_session` and agent_status "unknown": identical to an unoccupied pane. That is why
    // occupancy is decided by the poller's `agent list` index, which DOES see it, and not by this
    // field; `test/zombie-reaper.test.ts` pins the end-to-end consequence.
    const payload = JSON.stringify({
      result: { panes: [{ agent_status: "unknown", cwd: "/x", pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" }] },
    });
    expect(await listAllPanes(env, makeExec(payload))).toEqual([
      { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", hasAgent: false },
    ]);
  });

  it("reports a live-observed post-exit pane (the state the reaper exists to act on) as agentless", async () => {
    // Copied from a live `herdr pane list` entry for a pane whose Claude had exited (ids and paths
    // replaced with placeholders, nothing else changed): no `agent`, no `agent_session`, and
    // agent_status "unknown". `agent list` no longer reports it either, so both the pre-filter and
    // this field agree it is free — the one shape the reap path's `hasAgent === false` must accept.
    const payload = JSON.stringify({
      result: {
        panes: [{
          agent_status: "unknown", cwd: "/x", focused: false, foreground_cwd: "/x",
          pane_id: "w1:p2", revision: 0, tab_id: "w1:t2", terminal_id: "term_x", workspace_id: "w1",
        }],
      },
    });
    expect(await listAllPanes(env, makeExec(payload))).toEqual([
      { paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", hasAgent: false },
    ]);
  });

  it("treats any positive agent signal as occupied even without an `agent` string", async () => {
    const payload = JSON.stringify({
      result: { panes: [{ agent_status: "idle", cwd: "/x", pane_id: "w1:p3", tab_id: "w1:t3", workspace_id: "w1" }] },
    });
    const panes = await listAllPanes(env, makeExec(payload));
    expect(panes[0]!.hasAgent).toBe(true);
  });

  it("treats a lone `agent` string as occupied (no agent_session, status unknown)", async () => {
    // A Claude that herdr has registered but not yet settled: `agent` is present while
    // `agent_session` is still absent. Only the `agent` disjunct can catch this row.
    const payload = JSON.stringify({
      result: { panes: [{ agent: "claude", agent_status: "unknown", cwd: "/x", pane_id: "w1:p5", tab_id: "w1:t5", workspace_id: "w1" }] },
    });
    expect((await listAllPanes(env, makeExec(payload)))[0]!.hasAgent).toBe(true);
  });

  it("treats a lone agent_session as occupied (no `agent`, status unknown)", async () => {
    const payload = JSON.stringify({ result: { panes: [{ agent_status: "unknown", cwd: "/x", pane_id: "w1:p7", tab_id: "w1:t7", workspace_id: "w1",
      agent_session: { source: "herdr:claude", kind: "id", value: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } }] } });
    expect((await listAllPanes(env, makeExec(payload)))[0]!.hasAgent).toBe(true);
  });

  it("calls `pane list` with no --workspace flag", async () => {
    const exec = makeExec(JSON.stringify({ result: { panes: [] } }));
    await listAllPanes(env, exec);
    const args = (makeExec as unknown as { lastArgs: string[] }).lastArgs;
    expect(args).toContain("pane");
    expect(args).toContain("list");
    expect(args).not.toContain("--workspace");
  });

  it("returns [] on an unexpected shape rather than throwing (fail-safe: no evidence → no reap)", async () => {
    expect(await listAllPanes(env, makeExec("{}"))).toEqual([]);
    expect(await listAllPanes(env, makeExec(JSON.stringify({ result: { panes: [{ pane_id: "w1:p2" }] } })))).toEqual([]);
  });
});

describe("listAllPanes — unparseable pane list warning", () => {
  // The rate-limit Set in server/herdr.ts is module-global and keyed by env id; the "unexpected
  // shape" test above already consumes ENVIRONMENTS[0] ("work-local"). Each test here uses an env
  // id no earlier test has warned for, so the assertions below observe a clean rate-limit count
  // rather than one already tripped by another test in this file.

  it("warns once (rate-limited) on a malformed pane entry, matching the shape-warning text", async () => {
    const malformedEnv = getEnv("personal-local");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const payload = JSON.stringify({ result: { panes: [{ pane_id: "w1:p2" }] } });
      expect(await listAllPanes(malformedEnv, makeExec(payload))).toEqual([]);
      expect(await listAllPanes(malformedEnv, makeExec(payload))).toEqual([]); // same env again
      const matches = warn.mock.calls.flat().filter(
        (a): a is string => typeof a === "string" && a.includes("pane list: unexpected shape"),
      );
      expect(matches).toHaveLength(1); // one warning total, not one per call
    } finally {
      warn.mockRestore();
    }
  });

  it("also warns when the container (result/panes) is missing outright, not just a malformed entry", async () => {
    const missingContainerEnv = getEnv("work-remote");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await listAllPanes(missingContainerEnv, makeExec("{}"))).toEqual([]);
      const matches = warn.mock.calls.flat().filter(
        (a): a is string => typeof a === "string" && a.includes("pane list: unexpected shape"),
      );
      expect(matches).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
