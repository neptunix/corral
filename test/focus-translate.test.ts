import { describe, expect, it, vi } from "vitest";

import type { HerdrEnv } from "../environments.ts";
import { createFocusTranslator, type FocusOps } from "../server/focus-translate.ts";

const env: HerdrEnv = {
  id: "work-local", label: "Work", kind: "local",
  claudeConfigDirs: ["/home/u/.claude"],
  spawnCommand: "claude", repos: {},
};

function makeOps(over?: Partial<FocusOps>): { ops: FocusOps; calls: string[] } {
  const calls: string[] = [];
  const ops: FocusOps = {
    focusedTabId: () => { calls.push("read"); return Promise.resolve("w1:t1"); },
    tabIdOfPane: () => Promise.resolve("w2:t9"),
    tabFocus: (_e, tabId) => { calls.push(`focus ${tabId}`); return Promise.resolve(); },
    ...over,
  };
  return { ops, calls };
}

// Lets the fire-and-forget chain drain. The translator returns void by design — the operator's terminal
// must never wait on herdr — so tests await the microtask queue instead of a promise.
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("focus translation", () => {
  it("focuses the pane's tab on open and restores the previous tab on close", async () => {
    const { ops, calls } = makeOps();
    const t = createFocusTranslator(ops, { enabled: true });
    t.onAttachOpen(env, "w2:p9");
    await settle();
    expect(calls).toEqual(["read", "focus w2:t9"]);
    t.onAttachClose(env, "w2:p9");
    await settle();
    // The restore is what makes this safe to run on every open: the operator's view ends where it began,
    // while the pane has been focused and then blurred — the state Claude needs to write a recap.
    expect(calls).toEqual(["read", "focus w2:t9", "focus w1:t1"]);
  });

  it("does nothing at all when disabled", async () => {
    const { ops, calls } = makeOps();
    const t = createFocusTranslator(ops, { enabled: false });
    t.onAttachOpen(env, "w2:p9");
    t.onAttachClose(env, "w2:p9");
    await settle();
    expect(calls).toEqual([]);
  });

  // Without serialization the restore could run BEFORE the focus it undoes, inverting the cycle and
  // leaving the pane focused — the one state that yields no recap.
  it("keeps open and close in order even when close arrives immediately", async () => {
    const { ops, calls } = makeOps();
    const t = createFocusTranslator(ops, { enabled: true });
    t.onAttachOpen(env, "w2:p9");
    t.onAttachClose(env, "w2:p9");
    await settle();
    expect(calls).toEqual(["read", "focus w2:t9", "focus w1:t1"]);
  });

  it("restores nothing when herdr reported no focused tab", async () => {
    const { ops, calls } = makeOps({ focusedTabId: () => Promise.resolve(null) });
    const t = createFocusTranslator(ops, { enabled: true });
    t.onAttachOpen(env, "w2:p9");
    await settle();
    t.onAttachClose(env, "w2:p9");
    await settle();
    expect(calls).toEqual(["focus w2:t9"]);
  });

  it("ignores a close with no recorded open", async () => {
    const { ops, calls } = makeOps();
    const t = createFocusTranslator(ops, { enabled: true });
    t.onAttachClose(env, "w2:p9");
    await settle();
    expect(calls).toEqual([]);
  });

  it("reports a herdr failure instead of throwing into the attach path", async () => {
    const onError = vi.fn();
    const { ops } = makeOps({ tabFocus: () => Promise.reject(new Error("herdr down")) });
    const t = createFocusTranslator(ops, { enabled: true, onError });
    t.onAttachOpen(env, "w2:p9");
    await settle();
    expect(onError).toHaveBeenCalledWith("herdr down");
  });

  it("a failed open leaves the close a no-op rather than focusing something arbitrary", async () => {
    const calls: string[] = [];
    const ops: FocusOps = {
      focusedTabId: () => Promise.reject(new Error("tab list failed")),
      tabIdOfPane: () => Promise.resolve("w2:t9"),
      tabFocus: (_e, tabId) => { calls.push(`focus ${tabId}`); return Promise.resolve(); },
    };
    const t = createFocusTranslator(ops, { enabled: true, onError: () => undefined });
    t.onAttachOpen(env, "w2:p9");
    await settle();
    t.onAttachClose(env, "w2:p9");
    await settle();
    expect(calls).toEqual([]);
  });

  it("tracks panes independently", async () => {
    const calls: string[] = [];
    let current = "w1:t1";
    const ops: FocusOps = {
      focusedTabId: () => Promise.resolve(current),
      tabIdOfPane: (_e, paneId) => Promise.resolve(`tab-of-${paneId}`),
      tabFocus: (_e, tabId) => { calls.push(tabId); current = tabId; return Promise.resolve(); },
    };
    const t = createFocusTranslator(ops, { enabled: true });
    t.onAttachOpen(env, "w2:p1");
    await settle();
    t.onAttachOpen(env, "w2:p2");
    await settle();
    t.onAttachClose(env, "w2:p2");
    await settle();
    // p2's restore returns to p1's tab, not to p2's own — each pane restores what IT displaced.
    expect(calls).toEqual(["tab-of-w2:p1", "tab-of-w2:p2", "tab-of-w2:p1"]);
  });
});
