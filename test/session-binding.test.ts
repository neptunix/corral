import type { SessionLink } from "@shared/board-schema.ts";
import { describe, it, expect } from "vitest";

import { isSessionBound, resolveLinkIndex } from "../server/session-binding.ts";

function link(o: { paneId: string; sessionId: string | null; env?: string }): SessionLink {
  return {
    env: o.env ?? "work-local", paneId: o.paneId, tabId: "", tabLabel: "", workspaceId: "",
    workspaceLabel: "", name: o.paneId, cwdSnapshot: "", sessionId: o.sessionId,
  };
}
const OLD = "aaaaaaaa-1111-2222-3333-444444444444";
const NEW = "bbbbbbbb-5555-6666-7777-888888888888";

describe("isSessionBound — exact per-link complement of buildUnassigned", () => {
  it("a null-UUID link claims its pane (legacy)", () => {
    const links = [link({ paneId: "pX", sessionId: null })];
    expect(isSessionBound(links, { env: "work-local", paneId: "pX", liveSessionId: NEW })).toBe(true);
    expect(isSessionBound(links, { env: "work-local", paneId: "pY", liveSessionId: NEW })).toBe(false);
  });

  it("a UUID link claims its session regardless of pane", () => {
    const links = [link({ paneId: "pX", sessionId: OLD })];
    expect(isSessionBound(links, { env: "work-local", paneId: "pZ", liveSessionId: OLD })).toBe(true);
    expect(isSessionBound(links, { env: "work-local", paneId: "pX", liveSessionId: NEW })).toBe(false);
  });

  it("a stale non-null pane-mate does NOT bind the restarted session (the bug)", () => {
    const links = [link({ paneId: "pX", sessionId: OLD })];
    expect(isSessionBound(links, { env: "work-local", paneId: "pX", liveSessionId: NEW })).toBe(false);
  });

  it("the /new null window: a null liveSessionId never matches a non-null pane-mate", () => {
    const links = [link({ paneId: "pX", sessionId: OLD })];
    expect(isSessionBound(links, { env: "work-local", paneId: "pX", liveSessionId: null })).toBe(false);
  });

  it("is env-scoped", () => {
    const links = [link({ paneId: "pX", sessionId: null, env: "personal-local" })];
    expect(isSessionBound(links, { env: "work-local", paneId: "pX", liveSessionId: null })).toBe(false);
  });
});

describe("resolveLinkIndex — address one stored link", () => {
  it("prefers an explicit sessionId over paneId", () => {
    const links = [link({ paneId: "pX", sessionId: OLD }), link({ paneId: "pX", sessionId: NEW })];
    expect(resolveLinkIndex(links, { env: "work-local", paneId: "pX", sessionId: NEW, liveSessionId: null })).toBe(1);
  });

  it("falls back to paneId when no sessionId is given", () => {
    const links = [link({ paneId: "pX", sessionId: OLD })];
    expect(resolveLinkIndex(links, { env: "work-local", paneId: "pX", sessionId: null, liveSessionId: null })).toBe(0);
  });

  it("churn-heals by the live row's sessionId when the paneId misses", () => {
    const links = [link({ paneId: "old:p", sessionId: OLD })];
    expect(resolveLinkIndex(links, { env: "work-local", paneId: "new:p", sessionId: null, liveSessionId: OLD })).toBe(0);
  });

  it("returns -1 when an explicit sessionId matches nothing (NO paneId fallthrough)", () => {
    // A stale-frame sid must not resolve to the same-pane sibling — close/resume would hit the wrong one.
    const links = [link({ paneId: "pX", sessionId: OLD })];
    expect(resolveLinkIndex(links, { env: "work-local", paneId: "pX", sessionId: "nomatch", liveSessionId: null })).toBe(-1);
  });

  it("returns -1 on no match", () => {
    const links = [link({ paneId: "pX", sessionId: OLD })];
    expect(resolveLinkIndex(links, { env: "work-local", paneId: "pY", sessionId: null, liveSessionId: null })).toBe(-1);
  });
});
