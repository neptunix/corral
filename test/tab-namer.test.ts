import type { SessionRow } from "@shared/schema";
import { describe, it, expect } from "vitest";

import { computeRenames, type ClaudeNameRef } from "../server/tab-namer.ts";

const ESC = "\u001b"; // the escape byte, spelled out so the source stays plain ASCII

function row(paneId: string, tabId: string, tab: string): SessionRow {
  return {
    env: "e1", paneId, status: "working", agent: "claude", cwd: "/x",
    tab, workspace: "ws", tabId, workspaceId: "w1", sessionId: null,
    recap: null, recapAt: null, recapStatus: null, recapSource: null, statusline: null, statuslineStatus: null, claudeStatus: null, waitingFor: null, remoteControl: null, registryStatus: null, claudeName: null, claudeNameUserSet: null,
  };
}
function ref(name: string | null, userSet: boolean | null): ClaudeNameRef {
  return { name, userSet };
}

describe("computeRenames", () => {
  it("renames a tab whose canonical pane has a user-set name differing from the label", () => {
    const ops = computeRenames([row("pA", "t1", "1")], () => ref("my-name", true));
    expect(ops).toEqual([{ env: "e1", tabId: "t1", label: "my-name" }]);
  });

  it("skips a derived name (userSet false) and a pane with no registry record (userSet null)", () => {
    // Neither is a name the operator chose; renaming on either overwrites the label with an auto name.
    const rows = [row("pA", "t1", "1")];
    expect(computeRenames(rows, () => ref("auto-title", false))).toEqual([]);
    expect(computeRenames(rows, () => ref("auto-title", null))).toEqual([]);
  });

  it("no-op when the label already matches", () => {
    expect(computeRenames([row("pA", "t1", "my-name")], () => ref("my-name", true))).toEqual([]);
  });

  it("normalizes the label, and compares the NORMALIZED name against the tab", () => {
    // Normalizing AFTER the compare would leave a name that normalizes onto the current label
    // differing from `tab` every sweep, re-firing the same rename forever.
    expect(computeRenames([row("pA", "t1", "my-name")], () => ref("  my-name  ", true))).toEqual([]);
    expect(computeRenames([row("pA", "t1", "1")], () => ref(`${ESC}[31mmy-name${ESC}[0m`, true)))
      .toEqual([{ env: "e1", tabId: "t1", label: "my-name" }]);
    const ops = computeRenames([row("pA", "t1", "1")], () => ref("x".repeat(200), true));
    expect(ops[0]?.label).toHaveLength(96); // NAME_MAX graphemes, never the raw 200
  });

  it("skips a name that normalizes to empty", () => {
    expect(computeRenames([row("pA", "t1", "1")], () => ref("   ", true))).toEqual([]);
    expect(computeRenames([row("pA", "t1", "1")], () => ref(`${ESC}[0m`, true))).toEqual([]);
  });

  it("uses the lexicographically smallest paneId as the canonical pane per tab", () => {
    const rows = [row("pB", "t1", "1"), row("pA", "t1", "1")];
    const ops = computeRenames(rows, (r) => (r.paneId === "pA" ? ref("from-a", true) : ref("from-b", true)));
    expect(ops).toEqual([{ env: "e1", tabId: "t1", label: "from-a" }]);
  });

  it("skips rows without a tabId and empty/null names", () => {
    const noTab: SessionRow = { ...row("pA", "", "1"), tabId: undefined };
    expect(computeRenames([noTab], () => ref("x", true))).toEqual([]);
    expect(computeRenames([row("pA", "t1", "1")], () => ref("", true))).toEqual([]);
    expect(computeRenames([row("pA", "t1", "1")], () => ref(null, true))).toEqual([]);
  });
});
