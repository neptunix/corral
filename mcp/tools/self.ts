import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { formatWhoami } from "../digest.ts";
import type { Identity } from "../identity.ts";
import { runTool, toolText } from "./reply.ts";

export function whoamiHandler(identity: Identity): Promise<string> {
  return runTool(async () => formatWhoami(await identity.load(true)));
}

export function registerSelfTool(server: McpServer, identity: Identity): void {
  server.registerTool(
    "corral_whoami",
    {
      title: "Who am I in corral",
      description:
        "Identify THIS session: its corral environment, herdr pane/tab/workspace, Claude session id, cwd, model, context-window usage, cost, rate-limit windows, and the task card it is bound to (with that board's valid status column ids and every session attached to the card). Also lists the configured environments available to corral_spawn. Call this FIRST in any session running under corral — it is how you learn your assignment. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => toolText(await whoamiHandler(identity)),
  );
}
