import type { SessionRow } from "@shared/schema";
import { describe, expect, it } from "vitest";

import { buildLiveIndex, resolveLiveRow } from "../server/live-resolve.ts";

const row = (over: Partial<SessionRow> & { paneId: string }): SessionRow => ({
  env: "e", status: "idle", agent: "claude", cwd: "/c", tab: "t", workspace: "w",
  sessionId: null, recap: null, recapAt: null, recapStatus: null, statusline: null, statuslineStatus: null,
  ...over,
});
const S = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const S2 = "99999999-8888-7777-6666-555555555555";

describe("resolveLiveRow", () => {
  it("resolves a no-sessionId link by its live pane", () => {
    const idx = buildLiveIndex([row({ paneId: "p1" })]);
    expect(resolveLiveRow({ env: "e", paneId: "p1", sessionId: null }, idx)?.paneId).toBe("p1");
  });

  it("churn-heals a relocated session by sessionId to its current pane", () => {
    const idx = buildLiveIndex([row({ paneId: "new:p", sessionId: S })]);
    // link stored at old:p; session S now lives at new:p
    expect(resolveLiveRow({ env: "e", paneId: "old:p", sessionId: S }, idx)?.paneId).toBe("new:p");
  });

  it("returns undefined (detached) when a sessionId-bearing link matches no live row", () => {
    const idx = buildLiveIndex([row({ paneId: "p9", sessionId: S2 })]);
    expect(resolveLiveRow({ env: "e", paneId: "old:p", sessionId: S }, idx)).toBeUndefined();
  });

  it("never binds a reused pane to a stranger: a sessionId link ignores a pane now held by another session", () => {
    const idx = buildLiveIndex([row({ paneId: "p1", sessionId: S2 })]); // pane p1 now hosts S2
    expect(resolveLiveRow({ env: "e", paneId: "p1", sessionId: S }, idx)).toBeUndefined();
  });
});
