import type { LiveSessionData } from "@shared/board-schema";
import { describe, expect, it } from "vitest";

import { CLOSING_STATUS, RESUMING_STATUS } from "../web/src/lib/optimistic.ts";
import { sessionStateLabel, sessionStateTone } from "../web/src/lib/session-state.ts";

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

// The dot beside the label. It used to be coloured from herdr's agent_status while the words came from
// Claude's, and the two vocabularies overlap only on `idle` — so the board showed a "done"-coloured dot
// next to the word "idle". These pin that the two now agree, branch for branch with the label above.
describe("sessionStateTone", () => {
  it("is green while Claude is busy, whatever herdr says underneath", () => {
    expect(sessionStateTone(live({ status: "done", claudeStatus: "busy", registryStatus: "ok" }))).toBe("working");
  });

  // THE case that motivated this: herdr "done" + Claude "idle" used to render a sky-blue dot next to
  // the word "idle". The label wins, so the tone is idle's.
  it("follows Claude's idle even when herdr still says done", () => {
    expect(sessionStateTone(live({ status: "done", claudeStatus: "idle", registryStatus: "ok" }))).toBe("idle");
  });

  // ...and the mirror: herdr "working" + Claude "idle" used to render green next to the word "idle".
  it("follows Claude's idle even when herdr still says working", () => {
    expect(sessionStateTone(live({ status: "working", claudeStatus: "idle", registryStatus: "ok" }))).toBe("idle");
  });

  // A session that needs a human takes the same red as herdr's `blocked` and the attention feed.
  it("is the attention tone whenever Claude is waiting, with or without a reason", () => {
    expect(sessionStateTone(live({ status: "working", claudeStatus: "waiting", registryStatus: "ok" }))).toBe("attention");
    expect(sessionStateTone(live({ claudeStatus: "waiting", waitingFor: "input needed", registryStatus: "ok" }))).toBe("attention");
  });

  it("treats a Claude shell as at rest", () => {
    expect(sessionStateTone(live({ status: "working", claudeStatus: "shell", registryStatus: "ok" }))).toBe("idle");
  });

  // Every branch where the LABEL falls back to herdr's status, the tone must fall back too — otherwise
  // the pair disagrees again on exactly the rows that made this necessary.
  it("falls back to herdr's vocabulary wherever the label does", () => {
    for (const registryStatus of [null, "no-config-dirs"] as const) {
      expect(sessionStateTone(live({ status: "working", registryStatus })), `working/${String(registryStatus)}`).toBe("working");
      expect(sessionStateTone(live({ status: "blocked", registryStatus })), `blocked/${String(registryStatus)}`).toBe("attention");
      expect(sessionStateTone(live({ status: "done", registryStatus })), `done/${String(registryStatus)}`).toBe("done");
      expect(sessionStateTone(live({ status: "idle", registryStatus })), `idle/${String(registryStatus)}`).toBe("idle");
    }
    // ...including an ok read that simply carries no claudeStatus.
    expect(sessionStateTone(live({ status: "blocked", claudeStatus: null, registryStatus: "ok" }))).toBe("attention");
  });

  // "state unavailable" gets its OWN tone, not the quiet default: sharing a colour with `idle` would
  // show a session corral cannot read as one at rest — the exact failure registryStatus exists for.
  // A stale claudeStatus is still attached on a failed read and must not be coloured from.
  it("has a dedicated tone when the label says state unavailable", () => {
    for (const registryStatus of ["not-found", "bad-schema", "read-error"] as const) {
      expect(sessionStateTone(live({ status: "working", claudeStatus: "busy", registryStatus })), registryStatus).toBe("unavailable");
    }
  });

  // A Claude status this version does not know. The label prints the word verbatim, so a resting dot
  // beside it would be the original bug again — one Claude release away, since claudeStatus is a bare
  // string read from an undocumented file.
  it("does not claim a resting dot for a Claude status it does not recognise", () => {
    const s = live({ status: "working", claudeStatus: "compacting", registryStatus: "ok" });
    expect(sessionStateLabel(s)).toBe("compacting");
    expect(sessionStateTone(s)).toBe("unavailable");
  });

  // "starting" claims NOTHING, and green would be wrong rather than merely loud: sessionId stays null
  // forever for a bare-shell agent (docs/adr/0003) and for any pane started outside a herdr context
  // (server/poller.ts's install-drift warning), so those rows would glow with the strongest activity
  // colour on the board permanently.
  it("claims nothing while the label says starting", () => {
    for (const status of ["idle", "working", "unknown"]) {
      expect(sessionStateTone(live({ status, registryStatus: "no-session-ref" })), status).toBe("unknown");
    }
  });

  // The optimistic close/resume synthetics and a detached row are outside herdr's vocabulary. They land
  // on `unknown`, which both call sites map to the class the old herdr-keyed lookup already fell back
  // to — so this change does not repaint them.
  it("is unknown for the optimistic transients and for no live row", () => {
    // The real constants, not copies — a test that re-declares them stops testing the day they change.
    for (const status of [CLOSING_STATUS, RESUMING_STATUS, "unknown"]) {
      expect(sessionStateTone(live({ status, registryStatus: null })), status).toBe("unknown");
    }
    expect(sessionStateTone(null)).toBe("unknown");
  });

  // The invariant, as a PROPERTY over every real combination rather than as hand-picked cases: wherever
  // the label falls back to herdr's word, the tone must fall back to herdr's colour. Enumerated cases
  // drift as branches are added; this cannot. Sweeps 7 x 5 x 6 = 210 combinations.
  it("label and tone fall back to herdr together, for every field combination", () => {
    const registryStatuses = [null, "ok", "no-config-dirs", "no-session-ref", "not-found", "bad-schema", "read-error"] as const;
    let asserted = 0;
    for (const registryStatus of registryStatuses) {
      for (const status of ["working", "blocked", "done", "idle", CLOSING_STATUS]) {
        for (const claudeStatus of [null, "idle", "busy", "waiting", "shell", "compacting"]) {
          const s = live({ status, claudeStatus, registryStatus });
          if (sessionStateLabel(s) !== status) continue;
          // registryStatus null forces the herdr branch, so this is herdr's tone for that word.
          const herdr = sessionStateTone(live({ status, registryStatus: null }));
          expect(sessionStateTone(s), `${status}/${String(claudeStatus)}/${String(registryStatus)}`).toBe(herdr);
          asserted++;
        }
      }
    }
    // The loop must actually assert something — a `continue` that always fired would pass silently.
    expect(asserted).toBeGreaterThan(50);
  });
});
