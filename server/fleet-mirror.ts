import type { EnvState, Snapshot } from "@shared/schema";
import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { writeAtomic } from "./atomic-store.ts";
import { runGit } from "./git.ts";
import { UUID_RE } from "./herdr.ts";
import { displacingName } from "./link-name.ts";
import type { Poller } from "./poller.ts";

export const FLEET_MIRROR_FILENAME = "fleet-mirror.json";

// `sessionId` is schema-pinned to the uuid shape: this value later reaches an unquoted shell
// interpolation (`--resume ${id}` via `pane run`) and an SSH command (`sessionCwd`), so the pin is a
// load-bearing safety control, mirroring the per-link resume route's explicit UUID_RE gate.
// Fail secure: a record failing the regex never spawns.
const MirrorSessionSchema = z.object({
  sessionId: z.string().regex(UUID_RE),
  name: z.string(),
  cwd: z.string(),
  workspaceLabel: z.string(),
});

const MirrorEnvSchema = z.object({
  // last STRUCTURAL write, not last poll — compare-before-write skips no-op ticks
  updatedAt: z.number(),
  // Derived from `pendingIds.length > 0`, kept so an older build reading this file still sees the
  // env-level signal it expects (server/restore-format.ts, shared/schema.ts FleetRestoreEnvReport).
  pendingRestore: z.boolean(),
  // Additive (ADR 0008): the records actually awaiting restore, not a whole-env flag. Optional with
  // a default so a pre-existing file with no id list still validates — a failed validation here
  // sends readMirrorFile's caller down the "move aside, start empty" path, which is exactly what an
  // operator upgrading (or rolling back) mid-recovery must not hit.
  pendingIds: z.array(z.string().regex(UUID_RE)).default([]),
  sessions: z.array(MirrorSessionSchema),
});

const FleetMirrorFileSchema = z.object({
  version: z.literal(1),
  envs: z.record(z.string(), MirrorEnvSchema),
});

export type MirrorSession = z.infer<typeof MirrorSessionSchema>;
export type MirrorEnv = z.infer<typeof MirrorEnvSchema>;
export type FleetMirrorFile = z.infer<typeof FleetMirrorFileSchema>;

export function mirrorPath(dataDir: string): string {
  return path.join(dataDir, FLEET_MIRROR_FILENAME);
}

/** null = file absent (nothing ever recorded). Unreadable/invalid THROWS with the path in the
 *  message — restore must answer 500 naming the file, never guess. */
export function readMirrorFile(filePath: string): FleetMirrorFile | null {
  if (!existsSync(filePath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`fleet mirror ${filePath} is unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = FleetMirrorFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`fleet mirror ${filePath} failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

export interface FleetMirror {
  /** Subscribe to the poller; returns the unsubscribe function (reconcile.ts shape). */
  start(poller: Poller): () => void;
  /** Deep copy — tests and diagnostics only. */
  getState(): FleetMirrorFile;
}

// Field-wise, not JSON.stringify: key order across a file round-trip is not guaranteed (see
// recordsEqual in server/poller.ts for the same reasoning). Both sides are sorted by sessionId.
function sessionsEqual(a: readonly MirrorSession[], b: readonly MirrorSession[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => {
    const o = b[i];
    return r.sessionId === o?.sessionId && r.name === o.name
      && r.cwd === o.cwd && r.workspaceLabel === o.workspaceLabel;
  });
}

// Both sides sorted by the same rule as sessionsEqual's inputs.
function idsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export function createFleetMirror(opts: { readonly dataDir: string; readonly nowFn?: () => number }): FleetMirror {
  const filePath = mirrorPath(opts.dataDir);
  const now = opts.nowFn ?? Date.now;
  // The EnvState object each env last arrived with. The poller creates a new one only when it polls
  // that env; every other emission (another env's poll, a registry tick, a sweep) reuses it. Absent =
  // never observed → corral may have restarted during a herdr outage, so the transition is
  // unobservable → merge-only.
  const lastEnvState = new Map<string, EnvState>();
  // Per-env ids of non-pending records absent from the previous reachable observation (ADR 0008:
  // a record drops on its second consecutive miss). In-memory only — a corral restart enters the
  // merge branch first, which pins anything missing instead.
  const missedOnce = new Map<string, ReadonlySet<string>>();
  const warned = new Set<string>();
  let state: FleetMirrorFile;

  try {
    state = readMirrorFile(filePath) ?? { version: 1, envs: {} };
  } catch (err) {
    // Never silently discard, never silently stop mirroring: move the frozen state aside for manual
    // recovery and start fresh. A renameSync failure here throws at startup — fail loud, not quiet.
    const aside = `${filePath}.corrupt-${String(Math.floor(now() / 1000))}`;
    renameSync(filePath, aside);
    console.warn(`[fleet-mirror] ${err instanceof Error ? err.message : String(err)} — moved aside to ${aside}; starting a fresh mirror`);
    state = { version: 1, envs: {} };
  }
  // Disk-parity baseline: the serialization the disk is KNOWN to hold (advanced only on a successful
  // write). Seeded from the just-loaded (or empty) state, so persist() — called on EVERY snapshot —
  // no-ops until something actually changes: a fresh install with no sessions never creates the file
  // (404 no_mirror stays meaningful), while a FAILED write leaves this behind the in-memory state and
  // the very next tick retries. (Review finding: gating the write on a this-tick change flag instead
  // silently disabled that retry — the state mutates BEFORE the throw, so the flag never re-arms.)
  let lastWritten = JSON.stringify(state, null, 2);

  function persist(): void {
    const serialized = JSON.stringify(state, null, 2);
    if (serialized === lastWritten) return;
    writeAtomic(filePath, serialized);
    lastWritten = serialized;
  }

  function onSnapshot(s: Snapshot): void {
    // The poller's subscriber fan-out is unguarded and writeAtomic is synchronous — an uncaught throw
    // here would skip later subscribers and can kill the process. Contain everything; warn once per
    // distinct error so a permanent ENOSPC is not a log flood.
    try {
      for (const [envId, envState] of Object.entries(s.envs)) {
        const prev = lastEnvState.get(envId);
        // Not re-polled since the last emission: the same stale listing, so not a second miss.
        if (prev === envState) continue;
        lastEnvState.set(envId, envState);
        const prevReachable = prev?.reachable;
        if (!envState.reachable) continue; // outage: the mirror holds

        // Projection: live rows with a herdr-registered uuid. listSessions already uuid-gates
        // sessionId; the re-test also protects against non-listSessions snapshot producers.
        const liveIds = new Set<string>();
        const live: MirrorSession[] = [];
        for (const r of s.sessions) {
          if (r.env !== envId || r.sessionId === null) continue;
          if (!UUID_RE.test(r.sessionId) || liveIds.has(r.sessionId)) continue;
          liveIds.add(r.sessionId);
          // The session's own name when the operator set it, else the herdr tab label. Gated on
          // claudeNameUserSet like every other projection of this value: fleet-restore slugifies this
          // string into the restored session's TAB LABEL (server/fleet-restore.ts), so an ungated
          // auto-derived name would relabel tabs on restore — the rename server/tab-namer.ts refuses
          // to perform. Normalized here for the same reason it is everywhere else.
          const name = displacingName(r);
          live.push({ sessionId: r.sessionId, name: name !== "" ? name : r.tab, cwd: r.cwd, workspaceLabel: r.workspace });
        }

        const entry = state.envs[envId];
        const prevSessions = entry?.sessions ?? [];
        let nextSessions: MirrorSession[];
        let nextPendingIds: string[];
        if (prevReachable === true) {
          // Steady state (ADR 0008). A pending record is kept until it is live again — restore may
          // run long after herdr returns. Any other record follows the replacing policy, which drops
          // operator-closed sessions, but only on its second consecutive miss, so one anomalous poll
          // cannot empty the mirror.
          const prevPending = new Set(entry?.pendingIds ?? []);
          const prevMissed = missedOnce.get(envId);
          const missed = new Set<string>();
          nextSessions = [...live];
          nextPendingIds = [];
          for (const r of prevSessions) {
            if (liveIds.has(r.sessionId)) continue;
            if (prevPending.has(r.sessionId)) {
              nextSessions.push(r);
              nextPendingIds.push(r.sessionId);
            } else if (prevMissed?.has(r.sessionId) !== true) {
              nextSessions.push(r);
              missed.add(r.sessionId);
            }
          }
          missedOnce.set(envId, missed);
        } else {
          // Reachable after a gap, or first observation of this process: merge-only — add/update by
          // sessionId, drop nothing, pin every previously mirrored record still missing. corral may
          // restart while herdr is down; this is what stops the mirror being wiped when it does.
          const merged = new Map(prevSessions.map((r) => [r.sessionId, r]));
          for (const r of live) merged.set(r.sessionId, r);
          nextSessions = [...merged.values()];
          nextPendingIds = prevSessions.filter((r) => !liveIds.has(r.sessionId)).map((r) => r.sessionId);
          missedOnce.delete(envId);
        }
        // Deterministic order → structural compare cannot be fooled by snapshot ordering churn.
        nextSessions.sort((x, y) => (x.sessionId < y.sessionId ? -1 : x.sessionId > y.sessionId ? 1 : 0));
        nextPendingIds.sort();
        const nextPending = nextPendingIds.length > 0;

        // No entry and nothing live: record nothing, so a fresh install answers 404 no_mirror
        // instead of producing a file full of empty envs.
        if (entry === undefined && nextSessions.length === 0) continue;

        // Structural comparison decides only whether updatedAt moves — NOT whether persist() runs.
        if (
          entry?.pendingRestore !== nextPending
          || !idsEqual(entry.pendingIds, nextPendingIds)
          || !sessionsEqual(entry.sessions, nextSessions)
        ) {
          state.envs[envId] = {
            updatedAt: Math.floor(now() / 1000),
            pendingRestore: nextPending,
            pendingIds: nextPendingIds,
            sessions: nextSessions,
          };
        }
      }
      // Unconditional: persist() self-no-ops via the lastWritten compare, so a healthy identical
      // tick costs one small serialize — and a tick after a FAILED write retries it.
      persist();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!warned.has(msg)) {
        warned.add(msg);
        console.warn(`[fleet-mirror] snapshot handling failed (mirror may be stale): ${msg}`);
      }
    }
  }

  return {
    start(poller) {
      return poller.onSnapshot(onSnapshot);
    },
    getState() {
      return structuredClone(state);
    },
  };
}

/**
 * Call at startup, BEFORE the first mirror write and BEFORE git.start(): the board store auto-commits
 * `add -A`, and the mirror is derived state that must not churn that history. The `*` also excludes
 * writeAtomic's `.tmp` sibling. `git rm --cached` heals a store where a prior run ever tracked the
 * file (an ignored-but-tracked file churns forever); `--ignore-unmatch` makes it a no-op otherwise.
 */
export async function ensureMirrorGitignore(
  dataDir: string,
  gitFn: (cwd: string, args: readonly string[]) => Promise<void> = runGit,
): Promise<void> {
  const giPath = path.join(dataDir, ".gitignore");
  const line = `${FLEET_MIRROR_FILENAME}*`;
  let content = "";
  try {
    content = readFileSync(giPath, "utf8");
  } catch {
    // absent → created below
  }
  if (!content.split("\n").some((l) => l.trim() === line)) {
    const next = content === "" || content.endsWith("\n") ? `${content}${line}\n` : `${content}\n${line}\n`;
    writeAtomic(giPath, next);
  }
  try {
    await gitFn(dataDir, ["rm", "--cached", "--ignore-unmatch", "-q", FLEET_MIRROR_FILENAME]);
  } catch (err) {
    console.warn(`[fleet-mirror] git rm --cached failed (mirror may stay tracked): ${err instanceof Error ? err.message : String(err)}`);
  }
}
