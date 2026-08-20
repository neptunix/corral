import { createHash } from "node:crypto";

import type { RunTool, RunLocalToolOptions } from "../../exec-tool.ts";
import type { CheckDeps } from "../deps.ts";
import type { ProbeAnswer } from "./wire.ts";

/** One remote-probed fact bundle: per-path lookups plus the two whole-value facts ($HOME, $PATH). */
export interface FactSource {
  /** undefined = UNANSWERED (the tri-state's third state); a ProbeAnswer is always an answer. */
  readonly lookup: (path: string) => ProbeAnswer | undefined;
  /** null = unanswered. "" is an ANSWERED empty value (design: flows to a fatal row for PATH). */
  readonly home: string | null;
  readonly pathEnv: string | null;
}

/** Answers "nothing is installed" to everything — the synthetically-complete answered-negative map. */
export const NEGATIVE_FACTS: FactSource = {
  lookup: () => ({ kind: "absent" }),
  home: "",
  pathEnv: "",
};

export interface DepsRecorder {
  readonly deps: CheckDeps;
  /** Unanswered touches since the last drain — call after EACH producer call (per-call granularity). */
  readonly drain: () => readonly string[];
  /**
   * Every path asked OF THE FACT SOURCE, ever — the manifest guard's observation channel.
   * A locally-routed hashFile path (exact-set member) is a LOCAL fact: recorded in NEITHER
   * `asked` NOR the drain buffer — otherwise the manifest guard would demand `/repo/...` paths
   * the manifest rightly excludes.
   */
  readonly asked: ReadonlySet<string>;
}

export function createDepsRecorder(facts: FactSource, local: {
  readonly repoRoot: string;
  readonly nodeVersion: string;
  readonly now: () => number;
  /** exact-set membership — the ONLY paths hashed off the server's disk (drift baselines). */
  readonly localHashPaths: ReadonlySet<string>;
  readonly localHash: (p: string) => string | null;
}): DepsRecorder {
  const touched = new Set<string>();
  const asked = new Set<string>();

  function lookupTracked(p: string): ProbeAnswer | undefined {
    const answer = facts.lookup(p);
    asked.add(p);
    if (answer === undefined) touched.add(p);
    return answer;
  }

  const deps: CheckDeps = {
    get env(): NodeJS.ProcessEnv {
      if (facts.home === null) {
        touched.add("$HOME");
        return {};
      }
      return { HOME: facts.home };
    },
    get pathEnv(): string {
      if (facts.pathEnv === null) {
        touched.add("$PATH");
        return "";
      }
      return facts.pathEnv;
    },
    nodeVersion: local.nodeVersion,
    isFile: (p) => {
      const answer = lookupTracked(p);
      if (answer === undefined) return false;
      switch (answer.kind) {
        case "content":
        case "too-large":
        case "unreadable":
          return true;
        case "exec":
          // A remote `!exec` marker fires only after `[ -f ] && [ -x ]`, so an executable answer
          // already implies regular file — but `!not-exec` does NOT imply regular file.
          return answer.executable;
        case "absent":
        case "not-regular":
        case "dir":
        case "value":
        case "error":
          return false;
      }
    },
    isExec: (p) => {
      const answer = lookupTracked(p);
      if (answer === undefined) return false;
      switch (answer.kind) {
        case "content":
        case "too-large":
        case "unreadable":
        case "exec":
          return answer.executable;
        case "absent":
        case "not-regular":
        case "dir":
        case "value":
        case "error":
          return false;
      }
    },
    isDir: (p) => {
      const answer = lookupTracked(p);
      if (answer === undefined) return false;
      return answer.kind === "dir" && answer.exists;
    },
    readText: (p) => {
      const answer = lookupTracked(p);
      if (answer === undefined) return null;
      return answer.kind === "content" ? answer.bytes.toString("utf8") : null;
    },
    hashFile: (p) => {
      if (local.localHashPaths.has(p)) return local.localHash(p);
      const answer = lookupTracked(p);
      if (answer === undefined) return null;
      return answer.kind === "content" ? createHash("sha256").update(answer.bytes).digest("hex") : null;
    },
    repoRoot: local.repoRoot,
    now: local.now,
  };

  return {
    deps,
    drain: () => {
      const out = [...touched];
      touched.clear();
      return out;
    },
    asked,
  };
}

export interface RunRecorder {
  readonly run: RunTool;
  readonly drain: () => readonly string[];
}

/** Signature: `${bin} ${args.join(" ")}` + (extraEnv?.CLAUDE_CONFIG_DIR ? `@${dir}` : ""). */
export function toolCallSignature(bin: string, args: readonly string[], configDir: string | undefined): string {
  return `${bin} ${args.join(" ")}${configDir === undefined ? "" : `@${configDir}`}`;
}

export function createRunRecorder(answers: ReadonlyMap<string, ProbeAnswer>): RunRecorder {
  const touched = new Set<string>();

  const run = (
    bin: string,
    args: readonly string[],
    opts?: RunLocalToolOptions,
  ): Promise<string | null> => {
    const sig = toolCallSignature(bin, args, opts?.extraEnv?.CLAUDE_CONFIG_DIR);
    const answer = answers.get(sig);
    if (answer === undefined) {
      touched.add(sig);
      return Promise.resolve(null);
    }
    if (answer.kind === "value") return Promise.resolve(answer.text);
    if (answer.kind === "error") return Promise.resolve(null);
    // Defensive: only "value"/"error" are ever assigned to tool keys — any other kind is treated
    // as unanswered rather than silently asserting a false negative.
    touched.add(sig);
    return Promise.resolve(null);
  };

  return {
    run,
    drain: () => {
      const out = [...touched];
      touched.clear();
      return out;
    },
  };
}
