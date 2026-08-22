import type { EnrichedSessionLink, EnrichedTask } from "@shared/board-schema";
import { describe, expect, it } from "vitest";

import {
  applyOptimisticState, overrideKey, CLOSING_STATUS, RESUMING_STATUS, type OptimisticState,
} from "../web/src/lib/optimistic.ts";
import { sessionStateLabel } from "../web/src/lib/session-state.ts";

function link(over: Partial<EnrichedSessionLink> = {}): EnrichedSessionLink {
  return {
    env: "e", paneId: "p1", tabId: "t1", tabLabel: "tl", workspaceId: "w1", workspaceLabel: "wl",
    name: "n", cwdSnapshot: "/tmp", sessionId: null,
    live: { status: "working", model: null, ctxPct: null, detached: false, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, claudeStatus: null, claudeName: null, waitingFor: null, remoteControl: null, registryStatus: null },
    ...over,
  };
}

function task(sessions: readonly EnrichedSessionLink[]): EnrichedTask {
  return {
    id: "t_x", title: "T", description: "", status: "todo", priority: null,
    sessions: [...sessions], createdAt: 0, updatedAt: 0,
  };
}

describe("overrideKey", () => {
  it("prefers the sessionId when non-empty", () => {
    expect(overrideKey({ sessionId: "abc", env: "e", paneId: "p1" })).toBe("abc");
  });
  it("falls back to env:paneId when sessionId is null or empty", () => {
    expect(overrideKey({ sessionId: null, env: "e", paneId: "p1" })).toBe("e:p1");
    expect(overrideKey({ sessionId: "", env: "e", paneId: "p2" })).toBe("e:p2");
  });
});

describe("applyOptimisticState", () => {
  it("flips a live session to detached on 'closing'", () => {
    const s = link({ sessionId: "abc" });
    const overrides = new Map<string, OptimisticState>([["abc", "closing"]]);
    const [t] = applyOptimisticState([task([s])], overrides);
    const out = t?.sessions[0]?.live;
    expect(out?.detached).toBe(true);
    expect(out?.status).toBe(CLOSING_STATUS);
  });

  it("flips a detached session to live on 'resuming'", () => {
    const s = link({ sessionId: "abc", live: { status: "unknown", model: null, ctxPct: null, detached: true, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, claudeStatus: null, claudeName: null, waitingFor: null, remoteControl: null, registryStatus: null } });
    const overrides = new Map<string, OptimisticState>([["abc", "resuming"]]);
    const [t] = applyOptimisticState([task([s])], overrides);
    const out = t?.sessions[0]?.live;
    expect(out?.detached).toBe(false);
    expect(out?.status).toBe(RESUMING_STATUS);
  });

  it("matches by sessionId even after the paneId churns (resume rebind)", () => {
    // Override was recorded against the session's stable id; the enriched link now has a NEW paneId.
    const s = link({ sessionId: "abc", paneId: "p2", live: { status: "unknown", model: null, ctxPct: null, detached: true, recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, claudeStatus: null, claudeName: null, waitingFor: null, remoteControl: null, registryStatus: null } });
    const overrides = new Map<string, OptimisticState>([["abc", "resuming"]]);
    const [t] = applyOptimisticState([task([s])], overrides);
    expect(t?.sessions[0]?.live?.detached).toBe(false);
  });

  it("uses the env:paneId fallback key for a session with no sessionId", () => {
    const s = link({ sessionId: null, paneId: "p9" });
    const overrides = new Map<string, OptimisticState>([["e:p9", "closing"]]);
    const [t] = applyOptimisticState([task([s])], overrides);
    expect(t?.sessions[0]?.live?.detached).toBe(true);
  });

  it("leaves sessions with no override untouched (same reference)", () => {
    const s = link({ sessionId: "keep" });
    const t0 = task([s]);
    const [t] = applyOptimisticState([t0], new Map());
    expect(t?.sessions[0]).toBe(s);
  });

  it("does not mutate the input session's live object", () => {
    const s = link({ sessionId: "abc" });
    const overrides = new Map<string, OptimisticState>([["abc", "closing"]]);
    applyOptimisticState([task([s])], overrides);
    expect(s.live?.detached).toBe(false);
    expect(s.live?.status).toBe("working");
  });
});

describe("applyOptimisticState — the overlay must beat Claude's own state", () => {
  it("nulls registryStatus so the label shows the optimistic status, not the stale claudeStatus", () => {
    // A session that Claude's registry says is busy, which the operator has just asked to resume. If
    // the overlay carried registryStatus: "ok" through, sessionStateLabel would render "busy" and the
    // row would look untouched.
    const s = link({
      sessionId: "abc",
      live: {
        status: "working", model: null, ctxPct: null, detached: true, recap: null, recapAt: null, recapStatus: null, recapSource: null,
        statusline: null, claudeStatus: "busy", claudeName: null, waitingFor: null, remoteControl: true, registryStatus: "ok",
      },
    });
    const [t] = applyOptimisticState([task([s])], new Map<string, OptimisticState>([["abc", "resuming"]]));
    const out = t?.sessions[0]?.live;
    expect(out?.registryStatus).toBeNull();
    expect(out?.claudeStatus).toBeNull();
    expect(sessionStateLabel(out ?? null)).toBe(RESUMING_STATUS);
  });

  it("does the same for closing", () => {
    const s = link({
      sessionId: "abc",
      live: {
        status: "working", model: null, ctxPct: null, detached: false, recap: null, recapAt: null, recapStatus: null, recapSource: null,
        statusline: null, claudeStatus: "busy", claudeName: null, waitingFor: null, remoteControl: true, registryStatus: "ok",
      },
    });
    const [t] = applyOptimisticState([task([s])], new Map<string, OptimisticState>([["abc", "closing"]]));
    expect(sessionStateLabel(t?.sessions[0]?.live ?? null)).toBe(CLOSING_STATUS);
  });
});
