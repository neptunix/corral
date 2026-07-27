import { CorralError } from "../client.ts";

/**
 * Every tool returns TEXT, including failures: an MCP tool error surfaces as an exception the model
 * cannot reason about, whereas a plain sentence ("corral is not reachable — is the server running?")
 * is actionable. Only genuinely unexpected throws are re-raised.
 */
export async function runTool(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CorralError) return `corral error [${err.code}]: ${err.message}`;
    return `corral error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Wrap text in the MCP content envelope. */
export function toolText(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}
