import { CorralError } from "../client.ts";
import { oneLine, truncate } from "../digest.ts";

// The error path is a route into a tool reply that otherwise bypasses mcp/digest.ts's firewall
// entirely: `err.message` can be Zod's multi-line pretty-printed validation output, or herdr/SSH exec
// stderr from a spawn/close failure (arbitrary length, arbitrary newlines, and on a remote env that
// is remote output) — the exact shape of untrusted, unbounded text that module was hardened to bound.
const ERROR_MESSAGE_MAX = 300;

/**
 * Every tool returns TEXT, including failures: an MCP tool error surfaces as an exception the model
 * cannot reason about, whereas a plain sentence ("corral is not reachable — is the server running?")
 * is actionable. Only genuinely unexpected throws are re-raised.
 */
export async function runTool(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CorralError) {
      return `corral error [${err.code}]: ${truncate(oneLine(err.message), ERROR_MESSAGE_MAX)}`;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `corral error: ${truncate(oneLine(message), ERROR_MESSAGE_MAX)}`;
  }
}

/** Wrap text in the MCP content envelope. */
export function toolText(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}
