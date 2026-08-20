import type { Check } from "@shared/diagnostics-schema";
import { describe, it, expect } from "vitest";

import { envReachableChecks, suppressUnrunnable } from "../server/diagnostics/cascade.ts";

const NOW = 42;
const check = (over: Partial<Check>): Check => ({
  id: "x", key: "x", title: "X", state: "problem", severity: "warning", detail: "",
  doc: null, scope: { kind: "global" }, class: "cheap", checkedAt: NOW,
  startupOkLine: false, haltsStartup: false,
  ...over,
});

describe("envReachableChecks", () => {
  it("warns per unreachable environment and carries the error verbatim", () => {
    const cs = envReachableChecks({
      work: { reachable: true, kind: "local", label: "Work" },
      box: { reachable: false, kind: "remote", label: "Box", error: "ssh: connect to host <host> port 22: Operation timed out" },
    }, NOW);
    const bad = cs.find((c) => c.scope.kind === "env" && c.scope.envId === "box");
    expect(bad?.state).toBe("problem");
    expect(bad?.severity).toBe("warning");
    expect(bad?.detail).toContain("Operation timed out");
  });

  it("is ok for a reachable environment", () => {
    expect(envReachableChecks({ work: { reachable: true, kind: "local", label: "Work" } }, NOW)[0]?.state).toBe("ok");
  });

  it("renders a row even when error and label are absent — both are optional on the wire", () => {
    const cs = envReachableChecks({ box: { reachable: false } }, NOW);
    expect(cs).toHaveLength(1);
    expect(cs[0]?.title).toContain("box");
  });

  it("reports nothing for an environment the poller has not answered for", () => {
    expect(envReachableChecks({}, NOW)).toEqual([]);
  });
});

describe("suppressUnrunnable", () => {
  it("suppresses only the checks that need herdr, and counts them in one n/a row", () => {
    const out = suppressUnrunnable([
      check({ id: "herdr-version", key: "k1", scope: { kind: "env", envId: "box" } }),
      check({ id: "herdr-claude-integration", key: "k2", scope: { kind: "configDir", envId: "box", dir: "/d" } }),
    ], new Set(["box"]), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.state).toBe("n/a");
    expect(out[0]?.title).toContain("2");
  });

  it("KEEPS local filesystem checks — a dead socket does not stop reading settings.json", () => {
    const input = [
      check({ id: "capture-script", key: "k1", scope: { kind: "configDir", envId: "box", dir: "/d" } }),
      check({ id: "helper-drift", key: "k2", scope: { kind: "configDir", envId: "box", dir: "/d" } }),
      check({ id: "jq-present", key: "k3", scope: { kind: "env", envId: "box" } }),
    ];
    expect(suppressUnrunnable(input, new Set(["box"]), NOW)).toEqual(input);
  });

  it("keeps the reachability row itself — it is what explains the collapse", () => {
    const out = suppressUnrunnable([
      check({ id: "env-reachable", key: "k1", scope: { kind: "env", envId: "box" } }),
      check({ id: "herdr-version", key: "k2", scope: { kind: "env", envId: "box" } }),
    ], new Set(["box"]), NOW);
    expect(out.map((c) => c.id)).toEqual(["env-reachable", "env-unrunnable"]);
  });

  it("passes a remote-class check through untouched — its own probed outcome is its truth", () => {
    const input = [
      check({ id: "capture-script", key: "k1", class: "remote", scope: { kind: "configDir", envId: "box", dir: "/d" } }),
    ];
    expect(suppressUnrunnable(input, new Set(["box"]), NOW)).toEqual(input);
  });

  it("leaves reachable environments and global checks untouched, and no-ops with nothing unreachable", () => {
    const input = [check({ id: "g", key: "g" }), check({ id: "herdr-version", key: "h", scope: { kind: "env", envId: "work" } })];
    expect(suppressUnrunnable(input, new Set(["box"]), NOW)).toEqual(input);
    expect(suppressUnrunnable(input, new Set(), NOW)).toEqual(input);
  });
});
