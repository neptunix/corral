import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { PORT } from "../config.ts";
import { createClient } from "./client.ts";
import { createIdentity, readHerdrEnv } from "./identity.ts";
import { registerFleetTool } from "./tools/fleet.ts";
import { registerSelfTool } from "./tools/self.ts";
import { registerSessionTools } from "./tools/session.ts";
import { registerTaskTools } from "./tools/task.ts";

// NEVER write to stdout in this process: stdout is the MCP protocol channel. Diagnostics go to
// stderr via console.warn / console.error (which is also all `no-console` permits).
// PORT comes from config.ts (intFromEnv), NOT a raw `process.env.HERDR_DASH_PORT ?? "8787"` read —
// intFromEnv rejects an empty/non-integer var and falls back to 8787, whereas the raw read would
// have built "http://127.0.0.1:" and made every tool report unreachable while the server itself
// (which also uses config.ts) listened on 8787 as normal.
const BASE_URL = process.env.CORRAL_URL ?? `http://127.0.0.1:${String(PORT)}`;

const server = new McpServer({ name: "corral", version: "0.1.0" });
const ctx = readHerdrEnv(process.env, process.cwd());

if (ctx === null) {
  // Installed at user scope, so every session connects — but a session outside herdr has no pane to
  // be, so it gets an EMPTY tool list and pays no schema cost beyond the connection itself.
  console.warn("[corral-mcp] not running inside herdr (HERDR_ENV/HERDR_PANE_ID unset) — no tools exposed");
} else {
  const client = createClient(BASE_URL);
  const identity = createIdentity(client, ctx);
  registerSelfTool(server, identity);
  registerTaskTools(server, { client, identity });
  registerSessionTools(server, { client, identity });
  registerFleetTool(server, client);
}

await server.connect(new StdioServerTransport());
