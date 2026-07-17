// Client half of two server↔web contracts, kept in a plain module so vitest can pin them (there is
// no React component runner): the WS close codes minted in server/ws-attach.ts + server/pty-bridge.ts,
// and the attention-map key format minted in server/attention-store.ts. If either side drifts, the
// tests in test/web-protocol.test.ts fail under the same signal as the server suite.

// Server-side WS close codes mapped to operator-facing copy, so a failed attach renders a reason
// instead of a blank terminal (§3.5). 1000 = normal (pty exited / we closed).
export function closeMessage(code: number, reason: string): string {
  if (reason !== "") return reason;
  if (code === 4000) return "attach failed";
  if (code === 4001) return "attach unavailable";
  if (code === 1013) return "attach limit reached — too many terminals open";
  if (code === 1000) return "session ended";
  return "connection closed";
}

// Keys are `env:paneId` and a paneId may itself contain a colon (PANE_RE admits `:`), so split on the
// FIRST colon only — mirrors the attention-store's own key handling. Deriving (env, paneId) from the key
// alone satisfies the click↔record race rule (§3.5): never read the possibly-cleared record on click.
export function parseKey(key: string): { env: string; paneId: string } {
  const idx = key.indexOf(":");
  if (idx < 0) return { env: key, paneId: "" };
  return { env: key.slice(0, idx), paneId: key.slice(idx + 1) };
}
