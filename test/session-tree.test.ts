import { describe, expect, it } from "vitest";

import { FOLD_MIN_CLOSED, sessionItems } from "../web/src/lib/session-tree";
import type { SessionItem, TreeLink } from "../web/src/lib/session-tree";

interface L extends TreeLink { readonly name: string }

function mk(name: string, opts: { closed?: boolean; closing?: boolean; sid?: string | null; pane?: string; env?: string; by?: L | "operator" | { sessionId: string; env: string; paneId: string } } = {}): L {
  const by = opts.by;
  return {
    name,
    env: opts.env ?? "e1",
    paneId: opts.pane ?? `p-${name}`,
    sessionId: opts.sid === undefined ? `sid-${name}` : opts.sid,
    live: { detached: opts.closed === true || opts.closing === true, status: opts.closing === true ? "closing" : "idle" },
    ...(by === undefined ? {} : {
      spawnedBy: by === "operator" || !("name" in by) ? by : { sessionId: by.sessionId ?? "", env: by.env, paneId: by.paneId },
    }),
  };
}

/** Compact shape: "name" for a leaf, ["name", [...children]] for a parent, "~a,b" for a folded row. */
function shape(items: readonly SessionItem<L>[]): unknown[] {
  return items.map((i) => {
    if (i.kind === "folded") return `~${i.links.map((l) => l.name).join(",")}`;
    return i.children.length === 0 ? i.link.name : [i.link.name, shape(i.children)];
  });
}

describe("sessionItems — tree", () => {
  it("nests a session under the one that spawned it; operator and legacy links are roots", () => {
    const orch = mk("orch", { by: "operator" });
    const exec = mk("exec", { by: orch });
    const legacy = mk("legacy");
    expect(shape(sessionItems([orch, exec, legacy], false))).toEqual([["orch", ["exec"]], "legacy"]);
  });

  it("a parent on another card leaves the child a root", () => {
    const child = mk("child", { by: { sessionId: "elsewhere", env: "e1", paneId: "p-x" } });
    expect(shape(sessionItems([child], false))).toEqual(["child"]);
  });

  it("falls back to env+paneId only when the parent link has no sessionId yet", () => {
    const parent = mk("parent", { sid: null, pane: "p9" });
    const child = mk("child", { by: { sessionId: "not-yet-known", env: "e1", paneId: "p9" } });
    expect(shape(sessionItems([parent, child], false))).toEqual([["parent", ["child"]]]);
  });

  it("the paneId fallback does not cross environments", () => {
    const parent = mk("parent", { sid: null, pane: "p9", env: "e2" });
    const child = mk("child", { by: { sessionId: "not-yet-known", env: "e1", paneId: "p9" } });
    expect(shape(sessionItems([parent, child], false))).toEqual(["parent", "child"]);
  });

  it("does not match a reused pane whose link carries a different sessionId", () => {
    const other = mk("other", { sid: "sid-other", pane: "p9" });
    const child = mk("child", { by: { sessionId: "sid-gone", env: "e1", paneId: "p9" } });
    expect(shape(sessionItems([other, child], false))).toEqual(["other", "child"]);
  });

  it("a closed parent still anchors its children", () => {
    const orch = mk("orch", { closed: true });
    const exec = mk("exec", { by: orch });
    expect(shape(sessionItems([orch, exec], false))).toEqual([["orch", ["exec"]]]);
  });

  it("orders live siblings before closed ones, keeping spawn order within each", () => {
    const a = mk("a", { closed: true });
    const b = mk("b");
    const c = mk("c", { closed: true });
    const d = mk("d");
    expect(shape(sessionItems([a, b, c, d], false))).toEqual(["b", "d", "a", "c"]);
  });

  it("a closed session with a live descendant sorts with the live ones", () => {
    const gone = mk("gone", { closed: true });
    const cp = mk("cp", { closed: true });
    const kid = mk("kid", { by: cp });
    expect(shape(sessionItems([gone, cp, kid], false))).toEqual([["cp", ["kid"]], "gone"]);
  });

  it("caps nesting at three levels, flattening deeper sessions into the third", () => {
    const a = mk("a");
    const b = mk("b", { by: a });
    const c = mk("c", { by: b });
    const d = mk("d", { by: c });
    expect(shape(sessionItems([a, b, c, d], false))).toEqual([["a", [["b", ["c", "d"]]]]]);
  });

  it("survives a spawnedBy cycle without dropping sessions", () => {
    const a: L = { ...mk("a"), spawnedBy: { sessionId: "sid-b", env: "e1", paneId: "p-b" } };
    const b = mk("b", { by: a });
    const names = JSON.stringify(shape(sessionItems([a, b], false)));
    expect(names).toContain("\"a\"");
    expect(names).toContain("\"b\"");
  });
});

describe("sessionItems — folding closed sessions", () => {
  const closed = (n: number, by?: L): L[] =>
    Array.from({ length: n }, (_, i) => mk(`c${String(i)}`, { closed: true, ...(by === undefined ? {} : { by }) }));

  it("does not fold below the threshold", () => {
    const items = sessionItems([mk("live"), ...closed(FOLD_MIN_CLOSED - 1)], true);
    expect(items.some((i) => i.kind === "folded")).toBe(false);
  });

  it("folds fully-closed siblings into one row at their level", () => {
    const live = mk("live");
    const cs = closed(FOLD_MIN_CLOSED);
    expect(shape(sessionItems([live, ...cs], true))).toEqual(["live", `~${cs.map((c) => c.name).join(",")}`]);
  });

  it("a folded subtree carries its descendants", () => {
    const p = mk("p", { closed: true });
    const kids = closed(FOLD_MIN_CLOSED - 1, p);
    expect(shape(sessionItems([p, ...kids], true))).toEqual([`~p,${kids.map((k) => k.name).join(",")}`]);
  });

  it("never folds a closed parent that has a live child", () => {
    const p = mk("p", { closed: true });
    const kid = mk("kid", { by: p });
    const cs = closed(FOLD_MIN_CLOSED);
    expect(shape(sessionItems([p, kid, ...cs], true))).toEqual([["p", ["kid"]], `~${cs.map((c) => c.name).join(",")}`]);
  });

  it("folds closed children under a live parent at their own level", () => {
    const orch = mk("orch");
    const cs = closed(FOLD_MIN_CLOSED, orch);
    expect(shape(sessionItems([orch, ...cs], true))).toEqual([["orch", [`~${cs.map((c) => c.name).join(",")}`]]]);
  });

  it("never folds a session whose close is still in flight", () => {
    const cs = closed(FOLD_MIN_CLOSED);
    const closing = mk("closing", { closing: true });
    expect(shape(sessionItems([closing, ...cs], true))).toEqual(["closing", `~${cs.map((c) => c.name).join(",")}`]);
  });

  it("folds nothing when fold is off", () => {
    expect(sessionItems(closed(FOLD_MIN_CLOSED + 3), false).every((i) => i.kind === "session")).toBe(true);
  });
});
