import { buildManifest } from "./manifest.ts";
import { buildRound2, buildRoundF, buildRoundT, PROBE_TOTAL_CAP_BYTES } from "./script.ts";
import type { RemoteEnv, Round2Request, RoundSpec } from "./script.ts";
import { parseWire } from "./wire.ts";
import type { ParseResult, ProbeAnswer } from "./wire.ts";
import type { ExecFn } from "../../herdr.ts";

/** One SSH-probed environment's merged answers — Task 8's input for building a `FactSource`. */
export interface ProbeFacts {
  readonly byPath: ReadonlyMap<string, ProbeAnswer>; // manifest + round-2 paths → answers
  readonly home: string | null; // null = unanswered
  readonly pathEnv: string | null;
  readonly tools: ReadonlyMap<string, ProbeAnswer>; // toolCallSignature → answer
  /** total expected vs arrived across all rounds attempted — remote-probe's classification input */
  readonly expected: number;
  readonly arrived: number;
  readonly error: string | null; // first round-level error, for titles
}

export type Round2Planner = (facts: {
    readonly byPath: ReadonlyMap<string, ProbeAnswer>;
    readonly home: string | null;
    readonly pathEnv: string | null;
  }) => {
    readonly requests: readonly Round2Request[];
    /** screened-out or non-absolute paths, resolved to n/a with a reason by the adapter */
    readonly rejected: readonly { readonly path: string; readonly reason: string }[];
  };

/**
 * Executes rounds F, T (concurrent) and — conditionally — round 2, merging every round's parsed
 * answers into one `ProbeFacts`. Never rejects: each round's `exec` call is caught individually
 * inside `runRound`, so one environment's SSH failure (a rejected `defaultExec` on timeout or
 * `ssh`'s exit-255-on-unreachable-host) never destroys the whole sweep — it only empties that
 * round's answers and records the first error message.
 */
export async function runProbe(env: RemoteEnv, exec: ExecFn, planRound2: Round2Planner): Promise<ProbeFacts> {
  const manifest = buildManifest(env.claudeConfigDirs);
  const roundF = buildRoundF(env, manifest);
  const roundT = buildRoundT(env);

  let error: string | null = null;
  const noteError = (err: unknown): void => {
    error ??= err instanceof Error ? err.message : String(err);
  };

  const runRound = async (spec: RoundSpec): Promise<ParseResult> => {
    try {
      const { stdout } = await exec(spec.file, spec.args, { timeout: spec.timeoutMs });
      return parseWire(stdout, spec.expectedKeys, PROBE_TOTAL_CAP_BYTES);
    } catch (err) {
      noteError(err);
      return { answers: new Map(), missing: spec.expectedKeys };
    }
  };

  // `Promise.all` is safe here ONLY because `runRound` never rejects: its own try/catch absorbs
  // every `exec` failure into an empty `ParseResult` before returning. Nothing propagates out for
  // `Promise.all` to reject on, and F's failure can never suppress T's answers (or vice versa) —
  // this is the design's per-round catch requirement applied at the round level.
  const [fResult, tResult] = await Promise.all([runRound(roundF), runRound(roundT.spec)]);

  let expected = roundF.expectedKeys.size + roundT.spec.expectedKeys.size;
  let arrived = fResult.answers.size + tResult.answers.size;

  const byPath = new Map<string, ProbeAnswer>();
  for (const entry of manifest.entries) {
    const answer = fResult.answers.get(entry.key);
    if (answer !== undefined) byPath.set(entry.path, answer);
  }

  const tools = new Map<string, ProbeAnswer>();
  for (const t of roundT.tools) {
    const answer = tResult.answers.get(t.key);
    if (answer !== undefined) tools.set(t.signature, answer);
  }

  const valueText = (key: string): string | null => {
    const answer = fResult.answers.get(key);
    return answer?.kind === "value" ? answer.text : null;
  };
  const home = valueText(manifest.homeKey);
  const pathEnv = valueText(manifest.pathKey);

  // Round 2 is planned from F's settled facts (T's settling is incidental — both are already
  // awaited above) and runs only when the planner actually asks for something. `planRound2` and
  // `buildRound2` are caller/pure-config code, not `exec` — but they run inside the same try as a
  // second line of defense for the "never rejects" contract: a throw here must not escape either.
  try {
    const plan = planRound2({ byPath, home, pathEnv });
    if (plan.requests.length > 0) {
      const specs = buildRound2(env, plan.requests);
      const pathByKey = new Map(plan.requests.map((r) => [r.key, r.path]));
      const results = await Promise.all(specs.map((spec) => runRound(spec)));
      for (const spec of specs) expected += spec.expectedKeys.size;
      for (const result of results) {
        arrived += result.answers.size;
        for (const [key, answer] of result.answers) {
          const path = pathByKey.get(key);
          if (path !== undefined) byPath.set(path, answer);
        }
      }
    }
  } catch (err) {
    noteError(err);
  }

  return { byPath, home, pathEnv, tools, expected, arrived, error };
}
