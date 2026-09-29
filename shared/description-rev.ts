import { createHash } from "node:crypto";

// Node-only: server/ and mcp/ import this, the web bundle must not.
// The address is hashed in so a rev read from one card never validates a write to another.
export function descriptionRev(boardId: string, taskId: string, description: string): string {
  return createHash("sha256").update(`${boardId}/${taskId}\0${description}`).digest("hex").slice(0, 12);
}

export const DESCRIPTION_REV_RE = /^[0-9a-f]{12}$/;
