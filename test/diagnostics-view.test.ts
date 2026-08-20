import type { Check, DiagnosticsSnapshot } from "@shared/diagnostics-schema";
import { computeRollup, emptyDiagnostics } from "@shared/diagnostics-schema";
import { describe, expect, it } from "vitest";

import {
  badgeCount, buildFixPreset, groupChecks, headerStatus, maxCheckedAt, pickSnapshot, renderedChecks,
  syntheticChecks,
} from "../web/src/lib/diagnostics-view";

function check(over: Partial<Check> = {}): Check {
  return {
    id: "node-version", key: "node-version", title: "node 22 meets the floor",
    state: "ok", severity: "info", detail: "", doc: null,
    scope: { kind: "global" }, class: "cheap",
    checkedAt: 1_000, startupOkLine: true, haltsStartup: false,
    ...over,
  };
}

function snapshot(over: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return { ...emptyDiagnostics(), ...over };
}

describe("maxCheckedAt", () => {
  it("is null when nothing carries a timestamp", () => {
    expect(maxCheckedAt([])).toBe(null);
    expect(maxCheckedAt([check({ checkedAt: null })])).toBe(null);
  });

  it("ignores nulls and returns the newest", () => {
    expect(maxCheckedAt([check({ checkedAt: 5 }), check({ checkedAt: null }), check({ checkedAt: 9 })])).toBe(9);
  });
});

describe("pickSnapshot", () => {
  // THE BOARD SWITCH. useEventSource clears its frame on a url change and the seed effect clears the
  // seed, so App has nothing to hand over. That is not news from the server — hold what is on screen.
  it("holds the current rows when there is no carrier at all", () => {
    const held = snapshot({ checks: [check({ checkedAt: 100 })] });
    expect(pickSnapshot(held, null)).toBe(held);
  });

  it("takes the first real snapshot over the blank initial state", () => {
    const incoming = snapshot({ checks: [check()] });
    expect(pickSnapshot(emptyDiagnostics(), incoming)).toBe(incoming);
  });

  it("ignores a snapshot older than the one on screen", () => {
    const held = snapshot({ checks: [check({ checkedAt: 100 })] });
    const incoming = snapshot({ checks: [check({ checkedAt: 50 })] });
    expect(pickSnapshot(held, incoming)).toBe(held);
  });

  // A restarted corral publishes checks:[] until its first sweep completes — seconds, with remote
  // probes. Pinning pre-restart rows, red digit and all, with nothing marking them stale is worse
  // than briefly showing "waiting for the first sweep". A LIVE server saying nothing still wins.
  it("lets a live server's empty sweep replace stale rows after a restart", () => {
    const held = snapshot({ checks: [check({ checkedAt: 100 })] });
    const blank = emptyDiagnostics();
    expect(pickSnapshot(held, blank)).toBe(blank);
  });

  it("keeps the incumbent on a tie, so a redelivered sweep does not churn the panel", () => {
    const held = snapshot({ checks: [check({ checkedAt: 100 })] });
    const incoming = snapshot({ checks: [check({ checkedAt: 100 })] });
    expect(pickSnapshot(held, incoming)).toBe(held);
  });

  it("takes a strictly newer snapshot", () => {
    const held = snapshot({ checks: [check({ checkedAt: 100 })] });
    const incoming = snapshot({ checks: [check({ checkedAt: 101 })] });
    expect(pickSnapshot(held, incoming)).toBe(incoming);
  });

  // The Recheck response out-stamps the frame in flight behind it, so the fresh answer is not reverted.
  it("does not let a frame already in flight revert a newer recheck", () => {
    const rechecked = snapshot({ checks: [check({ checkedAt: 200 })] });
    const stale = snapshot({ checks: [check({ checkedAt: 150 })] });
    expect(pickSnapshot(rechecked, stale)).toBe(rechecked);
  });
});

describe("synthetic client checks", () => {
  it("reports a dead stream as a fatal the server could never file itself", () => {
    const rows = syntheticChecks(emptyDiagnostics(), true);
    expect(rows.map((r) => r.id)).toEqual(["backend-unreachable"]);
    expect(rows[0]?.state).toBe("problem");
    expect(rows[0]?.severity).toBe("fatal");
  });

  it("reports a sweep that failed, which the sweep publishing it cannot", () => {
    const rows = syntheticChecks(snapshot({ lastError: "ENOENT: herdr" }), false);
    expect(rows.map((r) => r.id)).toEqual(["sweep-failed"]);
    expect(rows[0]?.detail).toContain("ENOENT: herdr");
  });

  it("emits nothing when the stream is up and the sweep is healthy", () => {
    expect(syntheticChecks(snapshot({ checks: [check()] }), false)).toEqual([]);
  });

  // checkedAt is load-bearing: the header age is max(checkedAt) over server rows, and a client-minted
  // timestamp would make a dead backend read "checked just now" and freeze pickSnapshot's comparator.
  it("carries no timestamp, so it can never freshen the header age", () => {
    for (const row of syntheticChecks(snapshot({ lastError: "x" }), true)) {
      expect(row.checkedAt).toBe(null);
      expect(row.doc).toBe(null);
      expect(row.key).toBe(row.id);
      expect(row.haltsStartup).toBe(false);
      expect(row.startupOkLine).toBe(false);
    }
    expect(maxCheckedAt(syntheticChecks(snapshot({ lastError: "x" }), true))).toBe(null);
  });

  it("puts synthetic rows first in the rendered list", () => {
    const rows = renderedChecks(snapshot({ checks: [check()], lastError: "x" }), true);
    expect(rows.slice(0, 2).map((r) => r.id)).toEqual(["backend-unreachable", "sweep-failed"]);
    expect(rows).toHaveLength(3);
  });
});

const label = (id: string): string => (id === "e1" ? "Work (local)" : id);

describe("headerStatus", () => {
  it("says checking only when nothing has been rendered and no class has answered", () => {
    expect(headerStatus(computeRollup([]), 0, 0)).toBe("checking");
  });

  // An answered class with an empty row set is still an answer (server/diagnostics-store.ts:50) —
  // that is precisely what `answered` was added to make distinguishable.
  it("says ok when a class answered but produced no rows", () => {
    expect(headerStatus(computeRollup([]), 1, 0)).toBe("ok");
  });

  // THE REGRESSION GUARD. A row's severity can be set regardless of state — ranking by raw
  // severity instead of the rollup would paint a merely-pending row's install red.
  it("ignores a pending row's severity, so an unanswered check stays green", () => {
    const rows = [check({ state: "pending", severity: "fatal", checkedAt: 1 })];
    expect(headerStatus(computeRollup(rows), 1, rows.length)).toBe("ok");
  });

  it("ranks real problems by severity", () => {
    const rows = [check({ state: "problem", severity: "warning" }), check({ state: "problem", severity: "info" })];
    expect(headerStatus(computeRollup(rows), 1, rows.length)).toBe("warning");
  });

  it("reads info, not green, for an info-only snapshot", () => {
    const rows = [check({ state: "problem", severity: "info" })];
    expect(headerStatus(computeRollup(rows), 1, rows.length)).toBe("info");
  });

  it("does not say checking when a dead backend is the only thing rendered", () => {
    const rows = renderedChecks(emptyDiagnostics(), true);
    expect(headerStatus(computeRollup(rows), 0, rows.length)).toBe("fatal");
  });
});

describe("badgeCount", () => {
  it("counts fatal and warning problems only", () => {
    const rows = [
      check({ state: "problem", severity: "fatal" }),
      check({ state: "problem", severity: "warning" }),
      check({ state: "problem", severity: "info" }),
      check({ state: "pending", severity: "fatal" }),
      check({ state: "ok", severity: "fatal" }),
    ];
    expect(badgeCount(computeRollup(rows))).toBe(2);
  });

  it("counts an info-only problem as zero — an available update lights the dot, never the digit", () => {
    expect(badgeCount(computeRollup([check({ state: "problem", severity: "info" })]))).toBe(0);
  });

  it("includes a synthetic fatal the wire rollup cannot see", () => {
    expect(badgeCount(computeRollup(renderedChecks(emptyDiagnostics(), true)))).toBe(1);
  });
});

describe("groupChecks", () => {
  it("leads with the client group and never folds it into global", () => {
    const groups = groupChecks(renderedChecks(snapshot({ checks: [check()] }), true), label);
    expect(groups[0]?.key).toBe("client");
    expect(groups[0]?.problems.map((c) => c.id)).toEqual(["backend-unreachable"]);
    expect(groups[1]?.key).toBe("global");
  });

  it("labels an env group through the injected label source", () => {
    const rows = [check({ scope: { kind: "env", envId: "e1" }, key: "a@e1" })];
    expect(groupChecks(rows, label)[0]?.label).toBe("Work (local)");
  });

  // Sorting by raw severity would float a healthy row above a real problem.
  it("sorts problems above everything, and never ranks a non-problem by severity", () => {
    const rows = [
      check({ key: "k1", state: "ok", severity: "fatal" }),
      check({ key: "k2", state: "problem", severity: "warning" }),
      check({ key: "k3", state: "problem", severity: "fatal" }),
    ];
    const g = groupChecks(rows, label)[0];
    expect(g?.problems.map((c) => c.key)).toEqual(["k3", "k2"]);
    expect(g?.ok.map((c) => c.key)).toEqual(["k1"]);
  });

  it("splits the fold by kind so a green tick never covers a pending row", () => {
    const rows = [
      check({ key: "a", state: "ok" }), check({ key: "b", state: "n/a" }), check({ key: "c", state: "pending" }),
    ];
    const g = groupChecks(rows, label)[0];
    expect([g?.ok.length, g?.na.length, g?.pending.length]).toEqual([1, 1, 1]);
  });

  it("orders groups global, then env, then config dir", () => {
    const rows = [
      check({ key: "d", scope: { kind: "configDir", envId: "e1", dir: "~/.claude" } }),
      check({ key: "e", scope: { kind: "env", envId: "e1" } }),
      check({ key: "g", scope: { kind: "global" } }),
    ];
    expect(groupChecks(rows, label).map((x) => x.key)).toEqual(["global", "env:e1", "dir:e1:~/.claude"]);
  });
});

describe("buildFixPreset", () => {
  it("is null when nothing is a problem", () => {
    expect(buildFixPreset([check({ state: "ok" }), check({ key: "b", state: "n/a" })], label)).toBe(null);
  });

  it("is null when the only problem is synthetic — nothing a spawned session could fix", () => {
    const rows = syntheticChecks(snapshot({ lastError: "boom" }), true);
    expect(buildFixPreset(rows, label)).toBe(null);
  });

  it("titles singular for one problem, plural for more than one", () => {
    expect(buildFixPreset([check({ state: "problem" })], label)?.title).toBe("Fix 1 corral issue");
    expect(buildFixPreset([check({ key: "a", state: "problem" }), check({ key: "b", state: "problem" })], label)?.title)
      .toBe("Fix 2 corral issues");
  });

  it("the preset text opens with the skill invocation and excludes synthetic rows", () => {
    const rows = [
      ...syntheticChecks(snapshot({ lastError: "boom" }), true),
      check({ key: "real", state: "problem", title: "jq missing", detail: "not on PATH", doc: { anchor: "quick-start", title: "Quick start" } }),
    ];
    const built = buildFixPreset(rows, label);
    expect(built?.preset.text.startsWith("/corral-doctor")).toBe(true);
    expect(built?.preset.text).toContain("jq missing");
    expect(built?.preset.text).toContain("not on PATH");
    expect(built?.preset.text).toContain("Quick start");
    expect(built?.preset.text).not.toContain("corral is not answering");
  });

  // If the operator never installed skills/corral-doctor, the spawned session greets `/corral-doctor`
  // with "Unknown command" and has nothing else to go on — the prompt must give it a way out.
  it("names the skill file directly, so a session without the skill installed still has instructions", () => {
    const text = buildFixPreset([check({ state: "problem" })], label)?.preset.text ?? "";
    expect(text).toContain("skills/corral-doctor/SKILL.md");
  });

  // A human glancing at the board sees the card, not the Run tab — the description is what tells
  // them there is something to click, independent of the Claude-facing preset text.
  // The description IS the composed brief, not a separate hand-written claim about it — a claim like
  // "the fix prompt is already filled in" goes false the moment the (never-persisted) preset is gone,
  // e.g. the modal closes and reopens. The description is the durable copy; there is only one text.
  it("gives the card a description that is the SAME text as the preset — nothing else to go stale", () => {
    const built = buildFixPreset([check({ state: "problem" })], label);
    expect(built?.description).toBe(built?.preset.text);
    expect(built?.description).toContain("1 corral diagnostics problem");
  });

  it("orders rows fatal before warning before info, and names an env-scoped row's environment", () => {
    const rows = [
      check({ key: "i", state: "problem", severity: "info", title: "info row" }),
      check({ key: "w", state: "problem", severity: "warning", title: "warning row" }),
      check({ key: "f", state: "problem", severity: "fatal", title: "fatal row", scope: { kind: "env", envId: "e1" } }),
    ];
    const text = buildFixPreset(rows, label)?.preset.text ?? "";
    const at = (s: string): number => text.indexOf(s);
    expect(at("fatal row")).toBeGreaterThan(-1);
    expect(at("fatal row")).toBeLessThan(at("warning row"));
    expect(at("warning row")).toBeLessThan(at("info row"));
    expect(at("[Work (local)] [fatal] fatal row")).toBeGreaterThan(-1);
  });

  it("never exceeds the server's 2000-char startCommand cap, however many rows are outstanding", () => {
    const rows = Array.from({ length: 40 }, (_, i) => check({
      key: `k${String(i)}`, state: "problem", title: `problem number ${String(i)}`,
      detail: "some detail text that takes up real space in the composed brief",
    }));
    const text = buildFixPreset(rows, label)?.preset.text ?? "";
    expect(text.length).toBeLessThan(2000);
    expect(text).toContain("more — open the Health panel for the rest");
  });
});
