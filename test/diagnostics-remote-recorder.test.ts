import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createDepsRecorder, createRunRecorder, NEGATIVE_FACTS, toolCallSignature } from "../server/diagnostics/remote/recorder.ts";
import type { FactSource } from "../server/diagnostics/remote/recorder.ts";
import type { ProbeAnswer } from "../server/diagnostics/remote/wire.ts";

const facts = (m: Record<string, ProbeAnswer>, home: string | null = "/home/u", pathEnv: string | null = "/usr/bin"): FactSource =>
  ({ lookup: (p) => m[p], home, pathEnv });

const local = (over?: Partial<Parameters<typeof createDepsRecorder>[1]>): Parameters<typeof createDepsRecorder>[1] => ({
  repoRoot: "/repo", nodeVersion: "22.0.0", now: () => 7,
  localHashPaths: new Set(["/repo/scripts/corral-status-capture.sh"]),
  localHash: () => "localhash", ...over,
});

describe("createDepsRecorder", () => {
  it("answers content: isFile true, isExec from the bit, readText utf8, hashFile over BYTES", () => {
    const bytes = Buffer.from([0x68, 0x69, 0xff]); // not clean UTF-8 — hash must not go through text
    const r = createDepsRecorder(facts({ "/d/f": { kind: "content", bytes, executable: true } }), local());
    expect(r.deps.isFile("/d/f")).toBe(true);
    expect(r.deps.isExec("/d/f")).toBe(true);
    expect(r.deps.hashFile("/d/f")).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(r.drain()).toEqual([]); // all answered
  });

  it("answered-negative is a verdict, not a miss: absent/too-large/unreadable produce no drain entries", () => {
    const r = createDepsRecorder(facts({
      "/d/a": { kind: "absent" }, "/d/b": { kind: "too-large", executable: false },
      "/d/c": { kind: "unreadable", executable: true },
    }), local());
    expect(r.deps.isFile("/d/a")).toBe(false);
    expect(r.deps.isFile("/d/b")).toBe(true);
    expect(r.deps.readText("/d/b")).toBeNull(); // mirrors readGuarded's cap: null, answered
    expect(r.deps.isFile("/d/c")).toBe(true);   // an unreadable file still stats as a file locally
    expect(r.deps.isExec("/d/c")).toBe(true);
    expect(r.deps.readText("/d/c")).toBeNull(); // mirrors readGuarded on EACCES: null, answered
    expect(r.deps.hashFile("/d/c")).toBeNull();
    expect(r.drain()).toEqual([]);
  });

  it("exec answers isFile/isExec from the executable bit — a non-executable exec answer is NOT a file", () => {
    const r = createDepsRecorder(facts({
      "/d/x": { kind: "exec", executable: true }, "/d/y": { kind: "exec", executable: false },
    }), local());
    expect(r.deps.isFile("/d/x")).toBe(true);
    expect(r.deps.isExec("/d/x")).toBe(true);
    expect(r.deps.isFile("/d/y")).toBe(false); // !not-exec does not imply regular file
    expect(r.deps.isExec("/d/y")).toBe(false);
    expect(r.drain()).toEqual([]);
  });

  it("dir answers isDir from the exists bit", () => {
    const r = createDepsRecorder(facts({
      "/d/dir1": { kind: "dir", exists: true }, "/d/dir2": { kind: "dir", exists: false },
    }), local());
    expect(r.deps.isDir("/d/dir1")).toBe(true);
    expect(r.deps.isDir("/d/dir2")).toBe(false);
    expect(r.drain()).toEqual([]);
  });

  it("an unanswered path returns the negative value AND records the touch; drain resets", () => {
    const r = createDepsRecorder(facts({}), local());
    expect(r.deps.readText("/d/ghost")).toBeNull();
    expect(r.drain()).toEqual(["/d/ghost"]);
    expect(r.drain()).toEqual([]); // per-producer-call granularity needs the reset
  });

  it("routes hashFile by EXACT set membership — a sibling dir extending repoRoot is NOT local", () => {
    let localCalls = 0;
    const r = createDepsRecorder(facts({}), local({ localHash: () => { localCalls += 1; return "h"; } }));
    expect(r.deps.hashFile("/repo/scripts/corral-status-capture.sh")).toBe("h");
    expect(localCalls).toBe(1);
    expect(r.drain()).toEqual([]); // local hash is never a probe touch
    expect([...r.asked]).not.toContain("/repo/scripts/corral-status-capture.sh"); // …nor an asked path
    r.deps.hashFile("/repo-config/x"); // prefix-extends /repo — must go to the probe map
    expect(localCalls).toBe(1);
    expect(r.drain()).toEqual(["/repo-config/x"]);
    expect([...r.asked]).toContain("/repo-config/x");
  });

  it("pathEnv: '' answered is an empty PATH (no touch); null is unanswered (touch, returns '')", () => {
    const answered = createDepsRecorder(facts({}, "/home/u", ""), local());
    expect(answered.deps.pathEnv).toBe("");
    expect(answered.drain()).toEqual([]);
    const missing = createDepsRecorder(facts({}, "/home/u", null), local());
    expect(missing.deps.pathEnv).toBe("");
    expect(missing.drain()).toEqual(["$PATH"]);
  });

  it("env.HOME: unanswered home records a $HOME touch", () => {
    const r = createDepsRecorder(facts({}, null), local());
    expect(r.deps.env.HOME).toBeUndefined();
    expect(r.drain()).toEqual(["$HOME"]);
  });

  it("asked accumulates every function-member path across drains (manifest guard channel)", () => {
    const r = createDepsRecorder(facts({ "/d/a": { kind: "absent" } }), local());
    r.deps.isFile("/d/a"); r.drain(); r.deps.readText("/d/b"); r.drain();
    expect([...r.asked].sort()).toEqual(["/d/a", "/d/b"]);
  });

  it("NEGATIVE_FACTS answers everything negatively with no unanswered touches", () => {
    const r = createDepsRecorder(NEGATIVE_FACTS, local());
    expect(r.deps.isFile("/anything")).toBe(false);
    expect(r.deps.readText("/anything")).toBeNull();
    expect(r.deps.pathEnv).toBe("");
    expect(r.drain()).toEqual([]);
  });
});

describe("createRunRecorder", () => {
  const sig = toolCallSignature("herdr", ["--version"], undefined);

  it("value answers become trimmed output; error answers become null WITHOUT a drain entry", async () => {
    const r = createRunRecorder(new Map([
      [sig, { kind: "value", text: "herdr 0.7.5" }],
      [toolCallSignature("herdr", ["integration", "status"], "/d1"), { kind: "error" }],
    ]));
    expect(await r.run("herdr", ["--version"])).toBe("herdr 0.7.5");
    expect(await r.run("herdr", ["integration", "status"], { extraEnv: { CLAUDE_CONFIG_DIR: "/d1" } })).toBeNull();
    expect(r.drain()).toEqual([]);
  });

  it("a signature that never arrived returns null AND records — B1 at the RunTool seam", async () => {
    const r = createRunRecorder(new Map());
    expect(await r.run("herdr", ["--version"])).toBeNull();
    expect(r.drain()).toEqual([sig]);
  });

  it("distinguishes integration calls per config dir in the signature", () => {
    expect(toolCallSignature("herdr", ["integration", "status"], "/d1"))
      .not.toBe(toolCallSignature("herdr", ["integration", "status"], "/d2"));
  });
});
