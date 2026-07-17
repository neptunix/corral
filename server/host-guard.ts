const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function assertLoopback(host: string): void {
  if (!LOOPBACK.has(host)) {
    throw new Error(`refusing to bind non-loopback host "${host}" — corral has no auth, so it only binds loopback (spec §13)`);
  }
}

// SEC (anti-DNS-rebinding): the loopback bind is the only access control (there is no auth), but a
// page whose DNS rebinds to 127.0.0.1 becomes same-origin and can drive the whole REST/SSE API. Reject
// any request whose `Host` header isn't a loopback hostname. Port-ignored on purpose: prod is
// `127.0.0.1:PORT`, dev's Vite proxy forwards `127.0.0.1:8787` (changeOrigin) — both loopback — while an
// attacker's Host is its own domain. Parse via URL so `[::1]:8787` (brackets/port) and the `x@evil`
// userinfo trick are handled correctly; a malformed/absent Host fails closed.
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host === "") return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  // URL keeps an IPv6 literal in brackets (`[::1]`) — strip them before the set check.
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return LOOPBACK.has(bare);
}
