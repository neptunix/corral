import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import type { CorralClient } from "../mcp/client.ts";
import { createIdentity } from "../mcp/identity.ts";
import { registerBoardReadTool } from "../mcp/tools/board-read.ts";
import { registerFleetTool } from "../mcp/tools/fleet.ts";
import { registerSelfTool } from "../mcp/tools/self.ts";
import { registerSessionTools } from "../mcp/tools/session.ts";
import { registerUpdateTool } from "../mcp/tools/task-update.ts";
import { registerTaskTools } from "../mcp/tools/task.ts";

function unused(): never {
  throw new Error("a handler ran: an unknown argument reached it");
}

const client: CorralClient = {
  whoami: unused, attention: unused, state: unused, boards: unused, board: unused, appendLog: unused,
  createTask: unused, editTask: unused, attach: unused, spawn: unused, closeSession: unused, spawnTargets: unused,
};

async function connect(): Promise<Client> {
  const server = new McpServer({ name: "corral-test", version: "0" });
  const identity = createIdentity(client, { paneId: "w1:p1", socket: null, cwd: "/repo" });
  registerSelfTool(server, identity);
  registerTaskTools(server, { client, identity });
  registerBoardReadTool(server, { client, identity });
  registerUpdateTool(server, { client, identity });
  registerSessionTools(server, { client, identity, envScope: null });
  registerFleetTool(server, { client, identity });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(a);
  return c;
}

// The SDK strips unknown keys unless the schema is strict, and a stripped `boardId` or `target`
// silently fell back to the caller's own card or pane.
describe("every corral tool refuses an unknown argument", () => {
  it("covers all ten tools", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "corral_board_read", "corral_fleet", "corral_session_close", "corral_spawn", "corral_task_bind",
      "corral_task_create", "corral_task_log", "corral_task_read", "corral_task_update", "corral_whoami",
    ]);
    for (const t of tools) {
      const res = await c.callTool({ name: t.name, arguments: { card_id: "t_c2c2c2c" } });
      expect(res.isError, t.name).toBe(true);
      expect(JSON.stringify(res.content), t.name).toContain("card_id");
    }
  });
});

// The schema, not the handler, refuses these — pinned so a switch to a looser type cannot drop the valid set.
describe("corral_board_read refuses a bad filter value before the handler runs", () => {
  it("names the valid priorities; refuses a negative offset and an empty q", async () => {
    const c = await connect();
    const bad = await c.callTool({ name: "corral_board_read", arguments: { boardId: "b", priority: "p9" } });
    expect(bad.isError).toBe(true);
    const text = JSON.stringify(bad.content);
    for (const p of ["p0", "p1", "p2", "p3"]) expect(text).toContain(p);
    expect((await c.callTool({ name: "corral_board_read", arguments: { boardId: "b", offset: -1 } })).isError).toBe(true);
    expect((await c.callTool({ name: "corral_board_read", arguments: { boardId: "b", q: "" } })).isError).toBe(true);
  });
});
