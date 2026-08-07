import { describe, it, expect } from "vitest";

import { getEnv } from "../environments.ts";
import { listSessions, type ExecFn } from "../server/herdr.ts";

const VALID_UUID = "a13ad559-8e59-4b98-b420-2746ef0b94d8";

const baseExec: ExecFn = (_file, args) => {
  const cmd = [...args].join(" ");
  if (cmd === "workspace list")
    return Promise.resolve({ stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: "demo-api" }] } }), stderr: "" });
  if (cmd === "tab list")
    return Promise.resolve({ stdout: JSON.stringify({ result: { tabs: [{ tab_id: "w1:1", label: "jira", workspace_id: "w1" }] } }), stderr: "" });
  if (cmd === "agent list")
    return Promise.resolve({ stdout: JSON.stringify({ result: { agents: [{ agent: "claude", agent_status: "working", cwd: "/x", pane_id: "w1-1", tab_id: "w1:1", workspace_id: "w1" }] } }), stderr: "" });
  return Promise.resolve({ stdout: "{}", stderr: "" });
};

function execWithAgentSession(agentPatch: Record<string, unknown>): ExecFn {
  return (_file, args) => {
    const cmd = [...args].join(" ");
    if (cmd === "workspace list")
      return Promise.resolve({ stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: "ws" }] } }), stderr: "" });
    if (cmd === "tab list")
      return Promise.resolve({ stdout: JSON.stringify({ result: { tabs: [{ tab_id: "w1:1", label: "tab", workspace_id: "w1" }] } }), stderr: "" });
    if (cmd === "agent list")
      return Promise.resolve({
        stdout: JSON.stringify({
          result: {
            agents: [{ agent: "claude", agent_status: "working", cwd: "/x", pane_id: "w1-1", tab_id: "w1:1", workspace_id: "w1", ...agentPatch }],
          },
        }),
        stderr: "",
      });
    return Promise.resolve({ stdout: "{}", stderr: "" });
  };
}

describe("listSessions", () => {
  it("joins agents with tab + workspace labels", async () => {
    const rows = await listSessions(getEnv("work-local"), baseExec);
    expect(rows).toEqual([{
      env: "work-local", paneId: "w1-1", status: "working", agent: "claude",
      cwd: "/x", tab: "jira", workspace: "demo-api",
      tabId: "w1:1", workspaceId: "w1", // stable ids carried through for close/resume (#1)
      sessionId: null, recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null,
    }]);
  });

  it("falls back to '?' for unknown tab/workspace", async () => {
    const orphan: ExecFn = (_f, args) =>
      [...args].join(" ") === "agent list"
        ? Promise.resolve({ stdout: JSON.stringify({ result: { agents: [{ agent: "claude", agent_status: "idle", cwd: "/y", pane_id: "w9-1", tab_id: "zz", workspace_id: "zz" }] } }), stderr: "" })
        : Promise.resolve({ stdout: JSON.stringify({ result: {} }), stderr: "" });
    const rows = await listSessions(getEnv("work-local"), orphan);
    expect(rows[0]!.tab).toBe("?");
    expect(rows[0]!.workspace).toBe("?");
  });
});

describe("listSessions — non-claude agent entries", () => {
  // Repro from a live smoke: `herdr agent start smoke --workspace wB -- bash` emits an agent entry
  // with NO `agent` field (only `name`) — one such pane must not take the whole env unreachable.
  it("an entry without `agent` parses (agent falls back to '') instead of failing the env", async () => {
    const mixed: ExecFn = (_f, args) =>
      [...args].join(" ") === "agent list"
        ? Promise.resolve({
            stdout: JSON.stringify({ result: { agents: [
              { agent: "claude", agent_status: "working", cwd: "/x", pane_id: "w1-1", tab_id: "w1:1", workspace_id: "w1" },
              { agent_status: "unknown", cwd: "/y", name: "corral-smoke", pane_id: "w1-2", tab_id: "w1:1", workspace_id: "w1" },
            ] } }),
            stderr: "",
          })
        : Promise.resolve({ stdout: JSON.stringify({ result: {} }), stderr: "" });
    const rows = await listSessions(getEnv("work-local"), mixed);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.agent).toBe("");
    expect(rows[1]!.status).toBe("unknown");
  });
});

describe("listSessions — agent_session → sessionId", () => {
  it("no agent_session → sessionId null", async () => {
    const rows = await listSessions(getEnv("work-local"), execWithAgentSession({}));
    expect(rows[0]?.sessionId).toBeNull();
  });

  it("agent_session.kind !== 'id' → sessionId null", async () => {
    const rows = await listSessions(getEnv("work-local"), execWithAgentSession({
      agent_session: { source: "herdr:claude", agent: "claude", kind: "name", value: "my-session" },
    }));
    expect(rows[0]?.sessionId).toBeNull();
  });

  it("agent_session.kind === 'id' but value fails UUID pattern → sessionId null", async () => {
    const rows = await listSessions(getEnv("work-local"), execWithAgentSession({
      agent_session: { kind: "id", value: "not-a-uuid" },
    }));
    expect(rows[0]?.sessionId).toBeNull();
  });

  it("agent_session.kind === 'id' with valid UUID → sessionId populated", async () => {
    const rows = await listSessions(getEnv("work-local"), execWithAgentSession({
      agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: VALID_UUID },
    }));
    expect(rows[0]?.sessionId).toBe(VALID_UUID);
  });

  it("uppercase UUID letters are accepted", async () => {
    const upper = VALID_UUID.toUpperCase();
    const rows = await listSessions(getEnv("work-local"), execWithAgentSession({
      agent_session: { kind: "id", value: upper },
    }));
    expect(rows[0]?.sessionId).toBe(upper);
  });

  it("agent_session present but value field absent → sessionId null", async () => {
    const rows = await listSessions(getEnv("work-local"), execWithAgentSession({
      agent_session: { kind: "id" },
    }));
    expect(rows[0]?.sessionId).toBeNull();
  });
});
