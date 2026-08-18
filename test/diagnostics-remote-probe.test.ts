import { describe, expect, it } from "vitest";

import { buildManifest } from "../server/diagnostics/remote/manifest.ts";
import type { ProbeManifest } from "../server/diagnostics/remote/manifest.ts";
import { runProbe } from "../server/diagnostics/remote/probe.ts";
import { buildRound2, buildRoundT } from "../server/diagnostics/remote/script.ts";
import type { RemoteEnv, Round2Request, ToolRequest } from "../server/diagnostics/remote/script.ts";
import type { ExecFn } from "../server/herdr.ts";

const env: RemoteEnv = {
  id: "box", label: "box", kind: "remote", sshHost: "h", socket: "~/s.sock",
  herdrBin: "~/.local/bin/herdr", claudeConfigDirs: ["/far/.claude"], spawnCommand: "claude", repos: {},
};

const b64 = (s: string): string => Buffer.from(s).toString("base64");
const OK = { stdout: "", stderr: "" };

/** Canned round-F wire output: $PATH intentionally answered-EMPTY (exercises the "" !== null rule). */
function cannedF(manifest: ProbeManifest): string {
  const lines: string[] = [];
  for (const e of manifest.entries) {
    if (e.key === manifest.homeKey) lines.push(`${e.key}\tv:${b64("/home/u")}`);
    else if (e.key === manifest.pathKey) lines.push(`${e.key}\tv:${b64("")}`);
    else if (e.kind === "dir") lines.push(`${e.key}\t!dir`);
    else if (e.kind === "exec") lines.push(`${e.key}\t!not-exec`);
    else if (e.path.endsWith("/settings.json")) lines.push(`${e.key}\tf:${b64("{}")}`);
    else lines.push(`${e.key}\t!absent`);
  }
  return lines.join("\n");
}

function cannedT(tools: readonly ToolRequest[]): string {
  return tools.map((t) => `${t.key}\tv:${b64(t.signature.startsWith("herdr --version") ? "1.2.3" : "ok")}`).join("\n");
}

/** Routes a fake command by its literal remote-shell text, per the probe's own round tells. */
function routeCmd(args: readonly string[]): "T" | "R2" | "F" {
  const cmd = args[5] ?? "";
  if (cmd.includes("integration status")) return "T";
  if (cmd.includes("'r2_")) return "R2";
  return "F";
}

describe("runProbe", () => {
  it("merges F and T answers by path and by tool signature", async () => {
    const manifest = buildManifest(env.claudeConfigDirs);
    const roundT = buildRoundT(env);
    const exec: ExecFn = (_file, args) => {
      const which = routeCmd(args);
      if (which === "T") return Promise.resolve({ stdout: cannedT(roundT.tools), stderr: "" });
      return Promise.resolve({ stdout: cannedF(manifest), stderr: "" });
    };
    const facts = await runProbe(env, exec, () => ({ requests: [], rejected: [] }));
    expect(facts.byPath.get(`${env.claudeConfigDirs[0] ?? ""}/settings.json`)).toEqual({ kind: "content", bytes: Buffer.from("{}"), executable: false });
    expect(facts.tools.get("herdr --version")).toEqual({ kind: "value", text: "1.2.3" });
    expect(facts.tools.get("claude --version")).toEqual({ kind: "value", text: "ok" });
    expect(facts.home).toBe("/home/u");
    expect(facts.pathEnv).toBe(""); // answered-EMPTY, not unanswered
    expect(facts.error).toBeNull();
    expect(facts.arrived).toBe(facts.expected);
  });

  it("a hanging round T loses only the tool keys — every filesystem key still arrives", async () => {
    const manifest = buildManifest(env.claudeConfigDirs);
    const exec: ExecFn = (_file, args) => {
      const which = routeCmd(args);
      if (which === "T") return Promise.reject(new Error("ssh: connect ETIMEDOUT"));
      return Promise.resolve({ stdout: cannedF(manifest), stderr: "" });
    };
    const facts = await runProbe(env, exec, () => ({ requests: [], rejected: [] }));
    expect(facts.byPath.size).toBe(manifest.entries.length);
    expect(facts.tools.size).toBe(0);
    expect(facts.expected).toBeGreaterThan(facts.arrived);
    expect(facts.error).toContain("ETIMEDOUT");
  });

  it("a dead host (both rounds reject) yields zero arrivals and the error", async () => {
    const exec: ExecFn = () => Promise.reject(new Error("ssh: connect to host h port 22: unreachable"));
    const facts = await runProbe(env, exec, () => ({ requests: [], rejected: [] }));
    expect(facts.arrived).toBe(0);
    expect(facts.home).toBeNull();
    expect(facts.pathEnv).toBeNull();
    expect(facts.error).toContain("unreachable");
  });

  it("round 2 runs only when the planner asks, and its answers land in byPath", async () => {
    const manifest = buildManifest(env.claudeConfigDirs);
    const roundT = buildRoundT(env);
    let execCalls = 0;
    const request: Round2Request = { key: "r2_0", kind: "file", path: "/opt/tool/bin/thing" };
    const exec: ExecFn = (_file, args) => {
      execCalls += 1;
      const which = routeCmd(args);
      if (which === "T") return Promise.resolve({ stdout: cannedT(roundT.tools), stderr: "" });
      if (which === "R2") return Promise.resolve({ stdout: `r2_0\tf:${b64("#!/bin/sh")}`, stderr: "" });
      return Promise.resolve({ stdout: cannedF(manifest), stderr: "" });
    };
    const facts = await runProbe(env, exec, () => ({ requests: [request], rejected: [] }));
    expect(execCalls).toBe(3); // F, T, and round 2
    expect(facts.byPath.get("/opt/tool/bin/thing")).toEqual({ kind: "content", bytes: Buffer.from("#!/bin/sh"), executable: false });
  });

  it("a non-zero exit from ONE round-2 chunk does not reject runProbe", async () => {
    const manifest = buildManifest(env.claudeConfigDirs);
    const roundT = buildRoundT(env);
    // Long paths force buildRound2 to split into >1 chunk (same technique as script.test.ts).
    const requests: Round2Request[] = Array.from({ length: 4000 }, (_, i) =>
      ({ key: `r2_${String(i)}`, kind: "file" as const, path: `/very/long/path/number/${String(i)}/statusline command.sh` }));
    expect(buildRound2(env, requests).length).toBeGreaterThan(1); // sanity: fixture really chunks
    let r2Calls = 0;
    const exec: ExecFn = (_file, args) => {
      const which = routeCmd(args);
      if (which === "T") return Promise.resolve({ stdout: cannedT(roundT.tools), stderr: "" });
      if (which === "R2") {
        r2Calls += 1;
        if (r2Calls === 2) return Promise.reject(new Error("round-2 chunk 2 failed"));
        return Promise.resolve({ stdout: "r2_0\t!absent", stderr: "" });
      }
      return Promise.resolve({ stdout: cannedF(manifest), stderr: "" });
    };
    const facts = await runProbe(env, exec, () => ({ requests, rejected: [] })); // resolving at all is the assertion
    expect(facts.error).toContain("chunk 2 failed");
    expect(facts.expected).toBeGreaterThan(facts.arrived); // the rejected chunk's keys never arrived
  });

  it("never rejects — a throwing exec is contained", async () => {
    await expect(runProbe(env, () => Promise.reject(new Error("boom")), () => ({ requests: [], rejected: [] }))).resolves.toBeDefined();
  });

  it("never rejects — a throwing planRound2 is contained too", async () => {
    const manifest = buildManifest(env.claudeConfigDirs);
    const roundT = buildRoundT(env);
    const exec: ExecFn = (_file, args) => {
      const which = routeCmd(args);
      if (which === "T") return Promise.resolve({ stdout: cannedT(roundT.tools), stderr: "" });
      return Promise.resolve({ stdout: cannedF(manifest), stderr: "" });
    };
    const planRound2 = (): never => { throw new Error("planner exploded"); };
    const facts = await runProbe(env, exec, planRound2);
    expect(facts.error).toContain("planner exploded");
    expect(facts.byPath.size).toBe(manifest.entries.length); // F's answers still made it through
  });

  it("F and T are dispatched concurrently — T does not wait for F", async () => {
    const calls: ("F" | "T")[] = [];
    let resolveF: ((v: { stdout: string; stderr: string }) => void) | undefined;
    const fPromise = new Promise<{ stdout: string; stderr: string }>((resolve) => { resolveF = resolve; });
    const exec: ExecFn = (_file, args) => {
      const which = routeCmd(args);
      if (which === "T") {
        calls.push("T");
        return Promise.resolve(OK);
      }
      calls.push("F");
      return fPromise;
    };
    const pending = runProbe(env, exec, () => ({ requests: [], rejected: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the synchronous dispatch happen
    expect(calls).toContain("T"); // T's exec ran even though F's promise is still pending
    expect(resolveF).toBeDefined();
    resolveF?.(OK);
    await pending;
  });
});
