import os from "node:os";
import path from "node:path";

// Parse an integer env var. `Number("")` is `0` (not NaN), so a set-but-empty var would otherwise
// silently slip a bad value through (e.g. `HERDR_DASH_PORT="" → serve on port 0`). Reject empty /
// whitespace / non-integer input and an optional below-`min` value, falling back to `fallback`.
export function intFromEnv(name: string, fallback: number, opts?: { min?: number }): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (opts?.min !== undefined && n < opts.min) return fallback;
  return n;
}

export const HOST = process.env.HERDR_DASH_HOST ?? "127.0.0.1";
export const PORT = intFromEnv("HERDR_DASH_PORT", 8787, { min: 1 });
export const CHEAP_INTERVAL_MS = intFromEnv("HERDR_DASH_POLL_MS", 30000, { min: 1 }); // durable, not instant
export const ATTENTION_MIN_WORK_MS = intFromEnv("ATTENTION_MIN_WORK_MS", 600_000, { min: 0 }); // 10 min (§3.6)
export const LIST_TIMEOUT = 15000;
export const READ_TIMEOUT = 30000;
// #4: coalesce sub-second bursts to GET /read (each shells out to herdr/SSH). 1s is well under the
// Unassigned mini-terminal's 5s poll, so legit polling passes straight through; only bursts are damped.
export const READ_CACHE_TTL_MS = intFromEnv("READ_CACHE_TTL_MS", 1000, { min: 0 });

// Operator runtime + data home (env config now; board data later). Shareable: each user points
// CORRAL_HOME/CORRAL_CONFIG at their own location and writes their own environments.json.
export const CORRAL_HOME = process.env.CORRAL_HOME ?? path.join(os.homedir(), ".corral");
export const ENV_CONFIG_PATH = process.env.CORRAL_CONFIG ?? path.join(CORRAL_HOME, "environments.json");

// Recap capture configuration
export const RECAP_ENABLED = process.env.RECAP_ENABLED !== "false";
export const RECAP_INTERVAL_MS = intFromEnv("RECAP_INTERVAL_MS", 60000, { min: 1 });
export const RECAP_TAIL_BYTES = intFromEnv("RECAP_TAIL_BYTES", 262144, { min: 1 });
export const RECAP_READ_TIMEOUT_MS = intFromEnv("RECAP_READ_TIMEOUT_MS", 8000, { min: 1 });
export const RECAP_CONTENT_MAX = intFromEnv("RECAP_CONTENT_MAX", 4096, { min: 1 });

// Statusline capture (read-through, shares the recap sweep interval)
export const STATUSLINE_ENABLED = process.env.STATUSLINE_ENABLED !== "false";
export const STATUSLINE_READ_TIMEOUT_MS = intFromEnv("STATUSLINE_READ_TIMEOUT_MS", 8000, { min: 1 });
export const STATUSLINE_MAX_BYTES = intFromEnv("STATUSLINE_MAX_BYTES", 65536, { min: 1 });
export const STATUSLINE_STALE_MS = intFromEnv("STATUSLINE_STALE_MS", 120000, { min: 1 });

// Tab rename: corral renames a herdr tab to its Claude session name (user-set names only). Rides the
// statusline sweep, so it is effective only when STATUSLINE_ENABLED is also on.
export const TAB_RENAME_ENABLED = process.env.TAB_RENAME_ENABLED !== "false";

// Delay before the FIRST statusline sweep after start(). The sweep can't run at t=0 (it would race the
// initial poll and see no rows), so it is kicked once after this short delay — by which point the first
// poll has populated the rows — then runs every RECAP_INTERVAL_MS. Keeps startup renames near-instant.
export const SWEEP_INITIAL_DELAY_MS = intFromEnv("SWEEP_INITIAL_DELAY_MS", 5000, { min: 0 });

// Zombie-tab reaper: when a Claude session exits it leaves a shell-only tab behind (herdr keeps the
// pane, drops the agent). corral closes such tabs automatically once a detached link's tab has
// lingered for this grace window — long enough to rule out a poll flicker or a slow-to-register
// spawn. Set ZOMBIE_REAP_ENABLED=false to turn the reaper off entirely.
export const ZOMBIE_REAP_ENABLED = process.env.ZOMBIE_REAP_ENABLED !== "false";
export const ZOMBIE_REAP_GRACE_MS = intFromEnv("ZOMBIE_REAP_GRACE_MS", 20000, { min: 0 });

export const BOARD_DATA_DIR = process.env.BOARD_DATA_DIR ?? CORRAL_HOME;
export const GIT_COMMIT_INTERVAL_MS = 10_000;
export const SPAWN_TIMEOUT_MS = 60_000;

// ---- WebSocket live-terminal attach (§3.4/§3.7) ----
export const WS_MAX_PAYLOAD = 64 * 1024; // keyboard channel; ws's 100 MiB default is a needless DoS surface
export const WS_MAX_CONCURRENT = intFromEnv("WS_MAX_CONCURRENT", 3, { min: 1 }); // SEC-2 hard cap
export const WS_RATE_PER_WINDOW = intFromEnv("WS_RATE_PER_WINDOW", 10, { min: 1 }); // SEC-2 token bucket
export const WS_RATE_WINDOW_MS = intFromEnv("WS_RATE_WINDOW_MS", 10_000, { min: 1 });
export const WS_HEARTBEAT_MS = intFromEnv("WS_HEARTBEAT_MS", 30_000, { min: 1 }); // SEC-3 half-open browser reap
export const WS_KILL_GRACE_MS = intFromEnv("WS_KILL_GRACE_MS", 2_000, { min: 0 }); // SIGHUP→SIGKILL escalation
export const WS_PROBE_GRACE_MS = intFromEnv("WS_PROBE_GRACE_MS", 2_000, { min: 0 }); // exit-within → attach unavailable
export const ATTACH_AUDIT_LOG = path.join(CORRAL_HOME, "attach-audit.log"); // open/close only, no keystrokes (SEC-6)

// Drop-upload temp store. Files written here are bounded to one server run (swept on startup); no
// history/GC by design. macOS /var/folders is not reliably auto-purged, hence the explicit sweep.
export const UPLOAD_ROOT = path.join(os.tmpdir(), "corral-uploads");

// Brief store for MCP-driven spawns. A brief is written here and the launch command reads it via
// `$(cat <path>)`, so only a server-generated path ever reaches the pane's shell. MUST live outside
// BOARD_DATA_DIR/CORRAL_HOME: server/git.ts `git add -A`s that tree every GIT_COMMIT_INTERVAL_MS, and
// a brief written under it would be committed to the board-data repo's history permanently (this
// happened — a real brief was found committed and had to be purged from history by hand). Mirrors
// UPLOAD_ROOT for the same reason: os.tmpdir() is outside any git repo, which is what makes "bounded
// to one run" true rather than aspirational.
export const BRIEF_ROOT = path.join(os.tmpdir(), "corral-briefs");
// Cap so a runaway brief cannot blow the pane or the spawned session's context window.
export const BRIEF_MAX_BYTES = intFromEnv("BRIEF_MAX_BYTES", 16384, { min: 1 });
// Bounded post-spawn delay before a single brief file is unlinked (server/api.ts). `herdr pane run`
// (server/spawn.ts spawnSession, Step 4) returns once the daemon has been told to inject the launch
// command into the pane's pty — NOT once the pane's shell has actually executed `$(cat <path>)`. An
// unlink the instant spawnSession's promise settles would race that shell read, so deletion happens
// this long afterward instead. Bounds a brief's disk lifetime to one spawn attempt + this grace
// window, not the life of the server process (previously: one file leaked per spawn, forever).
export const BRIEF_CLEANUP_DELAY_MS = intFromEnv("BRIEF_CLEANUP_DELAY_MS", 5000, { min: 0 });

// SEC-1: WebSockets bypass same-origin policy, so the upgrade must Origin-allowlist. The Vite dev origin
// is added ONLY outside production — prod serves same-origin from web/dist, and keeping the dev origin in
// prod would be permanent standing attack surface. `assertLoopback` binds the server to 127.0.0.1 anyway.
export const WS_ALLOWED_ORIGINS: readonly string[] = [
  `http://127.0.0.1:${String(PORT)}`,
  `http://localhost:${String(PORT)}`,
  ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:5173"]),
];
