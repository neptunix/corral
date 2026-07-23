import type { SessionRow } from "@shared/schema";

export interface LiveIndex {
  readonly liveMap: Map<string, SessionRow>;
  readonly bySession: Map<string, SessionRow>;
}

export function buildLiveIndex(sessions: readonly SessionRow[]): LiveIndex {
  const liveMap = new Map<string, SessionRow>();
  const bySession = new Map<string, SessionRow>();
  for (const s of sessions) {
    liveMap.set(`${s.env}:${s.paneId}`, s);
    // Index by the stable Claude UUID so a stale-paneId link can resolve to its current pane.
    if (s.sessionId !== null && s.sessionId !== "") bySession.set(`${s.env}:${s.sessionId}`, s);
  }
  return { liveMap, bySession };
}

// Resolve a stored link to its live herdr row, or undefined when detached. When the link carries a
// stable sessionId we TRUST IT over the stored paneId: a herdr restart reassigns paneIds, so a paneId
// hit whose sessionId disagrees is a stale reuse (a stranger), not ours — we then resolve by the
// sessionId index instead, and a sessionId that resolves to nothing is genuinely detached (never
// mis-bound to whoever now holds the pane). Without a sessionId we fall back to the plain paneId hit
// (best-effort, legacy links). This is the single source of truth for liveness, shared by
// buildBoardState (read path) and the zombie reaper.
export function resolveLiveRow(
  link: { readonly env: string; readonly paneId: string; readonly sessionId: string | null },
  index: LiveIndex,
): SessionRow | undefined {
  const byPane = index.liveMap.get(`${link.env}:${link.paneId}`);
  if (link.sessionId !== null && link.sessionId !== "" && byPane?.sessionId !== link.sessionId) {
    return index.bySession.get(`${link.env}:${link.sessionId}`);
  }
  return byPane;
}
