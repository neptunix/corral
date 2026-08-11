import type { Snapshot } from "@shared/schema";
import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { writeAtomic } from "./atomic-store.ts";
import { UUID_RE } from "./herdr.ts";
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
  pendingRestore: z.boolean(),
  sessions: z.array(MirrorSessionSchema),
});

export const FleetMirrorFileSchema = z.object({
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
  /** Restore engine calls this after a run with zero failed outcomes for the env. */
  clearPendingRestore(envId: string): void;
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

export function createFleetMirror(opts: { readonly dataDir: string; readonly nowFn?: () => number }): FleetMirror {
  const filePath = mirrorPath(opts.dataDir);
  const now = opts.nowFn ?? Date.now;
  // Per-env reachability as of the previous OBSERVATION in this process. Reachability only changes in
  // pollEnv, so observing emissions is equivalent to observing polls. Absent = never observed →
  // corral may have restarted during a herdr outage, so the transition is unobservable → merge-only.
  const lastReachable = new Map<string, boolean>();
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
        const prevReachable = lastReachable.get(envId);
        lastReachable.set(envId, envState.reachable);
        if (!envState.reachable) continue; // outage: the mirror holds

        // Projection: live rows with a herdr-registered uuid. listSessions already uuid-gates
        // sessionId; the re-test also protects against non-listSessions snapshot producers.
        const liveIds = new Set<string>();
        const live: MirrorSession[] = [];
        for (const r of s.sessions) {
          if (r.env !== envId || r.sessionId === null) continue;
          if (!UUID_RE.test(r.sessionId) || liveIds.has(r.sessionId)) continue;
          liveIds.add(r.sessionId);
          live.push({ sessionId: r.sessionId, name: r.tab, cwd: r.cwd, workspaceLabel: r.workspace });
        }

        const entry = state.envs[envId];
        const prevSessions = entry?.sessions ?? [];
        const pending = entry?.pendingRestore ?? false;
        let nextSessions: MirrorSession[];
        let nextPending: boolean;
        if (prevReachable === true && !pending) {
          // Steady state → replace: this is what drops operator-closed sessions so restore never
          // resurrects them.
          nextSessions = live;
          nextPending = false;
        } else {
          // Reachable after a gap, first observation of this process, or pendingRestore → merge-only:
          // add/update by sessionId, drop nothing. pendingRestore = "some previously mirrored record
          // is still not back"; it survives any number of polls, corral restarts and partial restores.
          const merged = new Map(prevSessions.map((r) => [r.sessionId, r]));
          for (const r of live) merged.set(r.sessionId, r);
          nextSessions = [...merged.values()];
          nextPending = prevSessions.some((r) => !liveIds.has(r.sessionId));
        }
        // Deterministic order → structural compare cannot be fooled by snapshot ordering churn.
        nextSessions.sort((x, y) => (x.sessionId < y.sessionId ? -1 : x.sessionId > y.sessionId ? 1 : 0));

        // No entry and nothing live: record nothing, so a fresh install answers 404 no_mirror
        // instead of producing a file full of empty envs.
        if (entry === undefined && nextSessions.length === 0) continue;

        // Structural comparison decides only whether updatedAt moves — NOT whether persist() runs.
        if (entry?.pendingRestore !== nextPending || !sessionsEqual(entry.sessions, nextSessions)) {
          state.envs[envId] = { updatedAt: Math.floor(now() / 1000), pendingRestore: nextPending, sessions: nextSessions };
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
    clearPendingRestore(envId) {
      const entry = state.envs[envId];
      if (!entry?.pendingRestore) return;
      state.envs[envId] = { ...entry, pendingRestore: false, updatedAt: Math.floor(now() / 1000) };
      try {
        persist();
      } catch (err) {
        // The restore itself succeeded; a failed flag write must not fail the route. The next
        // snapshot tick's unconditional persist() retries it (lastWritten only moves on success).
        console.warn(`[fleet-mirror] clearPendingRestore(${envId}) write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    getState() {
      return structuredClone(state);
    },
  };
}
