import type { LiveSessionData } from "@shared/board-schema";
import { describe, expect, it } from "vitest";

import { sessionStateLabel } from "../web/src/lib/session-state.ts";

const live = (over: Partial<LiveSessionData>): LiveSessionData => ({
  status: "working", model: null, ctxPct: null, detached: false,
  recap: null, recapAt: null, statusline: null,
  claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null,
  ...over,
});

describe("sessionStateLabel", () => {
  it("prefers Claude's own status over herdr's agent_status", () => {
    expect(sessionStateLabel(live({ status: "working", claudeStatus: "busy", registryStatus: "ok" }))).toBe("busy");
  });

  it("names what is holding the input line", () => {
    expect(sessionStateLabel(live({ claudeStatus: "waiting", waitingFor: "input needed", registryStatus: "ok" })))
      .toBe("waiting · input needed");
  });

  it("shows a bare waiting when there is no reason", () => {
    expect(sessionStateLabel(live({ claudeStatus: "waiting", registryStatus: "ok" }))).toBe("waiting");
  });

  // An empty string is not a reason. Without this the label reads "waiting · " with a dangling
  // separator, which looks like a rendering bug rather than a missing value.
  it("shows a bare waiting when the reason is an empty string", () => {
    expect(sessionStateLabel(live({ claudeStatus: "waiting", waitingFor: "", registryStatus: "ok" }))).toBe("waiting");
  });

  // waitingFor belongs to `waiting` alone. A stale reason left on a busy record must not be appended,
  // or the board says "busy · input needed" — two contradictory claims in one label.
  it("does not append a reason to a status that is not waiting", () => {
    expect(sessionStateLabel(live({ claudeStatus: "busy", waitingFor: "input needed", registryStatus: "ok" }))).toBe("busy");
  });

  // THE distinction the Goals require: a session corral cannot see the state of must not be shown as
  // an idle one. Every read FAILURE maps here, and none of them maps to "idle".
  it("renders every degraded read as 'state unavailable', never as idle", () => {
    for (const registryStatus of ["not-found", "bad-schema", "read-error"] as const) {
      expect(sessionStateLabel(live({ registryStatus })), registryStatus).toBe("state unavailable");
    }
  });

  // And it stays unavailable even when a stale record is still cached beside the failure — the poller
  // deliberately keeps the last good record on a failed read, so this is a reachable state, not a
  // hypothetical one.
  it("says 'state unavailable' even when a stale claudeStatus is still attached", () => {
    expect(sessionStateLabel(live({ status: "working", claudeStatus: "busy", registryStatus: "read-error" })))
      .toBe("state unavailable");
  });

  // `no-config-dirs` is the DEFAULT for every remote environment (claudeConfigDirs defaults to []), so
  // treating it as a read failure would replace the herdr status corral genuinely knows with "state
  // unavailable" on every remote session, permanently, on a healthy fleet. It is a configuration
  // statement about the environment, reported once in the startup report — not a per-session failure.
  it("falls back to herdr's status when the environment has no config dirs at all", () => {
    expect(sessionStateLabel(live({ status: "working", registryStatus: "no-config-dirs" }))).toBe("working");
  });

  // The window between pane creation and Claude registering — the moment a freshly spawned session is
  // most interesting and least attributable.
  it("says 'starting' while the pane has no session id yet", () => {
    expect(sessionStateLabel(live({ registryStatus: "no-session-ref" }))).toBe("starting");
  });

  // ...and "starting" wins over whatever herdr says, or a brand-new pane reads "idle" for the seconds
  // that matter most.
  it("says 'starting' regardless of the herdr status underneath", () => {
    expect(sessionStateLabel(live({ status: "idle", registryStatus: "no-session-ref" }))).toBe("starting");
  });

  // The registry has not been read for this pane at all (the first sweep has not landed). Falling back
  // to herdr's status is right; claiming "state unavailable" would be a permanent false alarm.
  it("falls back to herdr's status when the registry has not been consulted", () => {
    expect(sessionStateLabel(live({ status: "working", registryStatus: null }))).toBe("working");
  });

  // A successful read that simply carries no status for this session: fall back rather than render an
  // empty label.
  it("falls back to herdr's status on an ok read with no claudeStatus", () => {
    expect(sessionStateLabel(live({ status: "working", claudeStatus: null, registryStatus: "ok" }))).toBe("working");
  });

  it("is 'unknown' with no live row at all", () => {
    expect(sessionStateLabel(null)).toBe("unknown");
  });
});
