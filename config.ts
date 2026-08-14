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

/**
 * Focus translation: corral drives `herdr tab focus` so a Claude session's terminal focus state actually
 * changes. This is what keeps the `away_summary` recap alive.
 *
 * Claude emits that recap only while its focus state is `blurred`, and that state is set ONLY by
 * terminal focus-report sequences. On a host terminal that reports no focus at all, the only producer of
 * those sequences is herdr itself — so once the operator moved from switching herdr tabs to watching the
 * corral board, no session was ever blurred again and the source went silent (measured: last record
 * 2026-07-31, zero across ~645 sessions after). corral had de-energized its own recap source.
 *
 * Two places translate focus, both derived from that mechanism:
 * - opening/closing a session's web terminal: focus the session's tab, then restore the previously
 *   focused tab — a full focus-in/out cycle for the pane, and the operator's own view ends where it
 *   started;
 * - `tab create` at spawn: an explicit focus flag, because a never-focused pane is `unknown`, not
 *   `blurred`, and could never produce a recap at all. This one MOVES the operator's view and does NOT
 *   restore it, including on a spawn another Claude session requested over MCP. That is not an
 *   oversight: at create time the pane holds a shell, not Claude, so a focus-out delivered right after
 *   would reach the shell and be discarded — leaving Claude, which starts moments later, back at
 *   `unknown`. The tab has to KEEP the focus until some later focus event blurs it (the next spawn, or
 *   any session opened on the board), and that event is what puts Claude in `blurred`.
 *
 * Set FOCUS_TRANSLATION_ENABLED=false to leave herdr's focus strictly alone (spawns then create tabs
 * with `--no-focus`); the recap ladder in server/transcript.ts keeps working either way.
 */
export const FOCUS_TRANSLATION_ENABLED = process.env.FOCUS_TRANSLATION_ENABLED !== "false";

// Tab rename: corral renames a herdr tab to its Claude session name (user-set names only). Rides the
// statusline sweep, so it is effective only when STATUSLINE_ENABLED is also on.
export const TAB_RENAME_ENABLED = process.env.TAB_RENAME_ENABLED !== "false";

// Claude session registry (<claude-config-dir>/sessions/<pid>.json). Read directly rather than through
// the statusline capture: the session itself rewrites this file on every state change, so it is the
// freshest view of a session that exists outside the session.
export const CLAUDE_REGISTRY_READ_TIMEOUT_MS = intFromEnv("CLAUDE_REGISTRY_READ_TIMEOUT_MS", 8000, { min: 1 });
// Applies to the received stream on the remote path and to the sum of file sizes on the local one.
export const CLAUDE_REGISTRY_MAX_BYTES = intFromEnv("CLAUDE_REGISTRY_MAX_BYTES", 262144, { min: 1 });
// Files for DEAD sessions are never cleaned up, so the count grows with history rather than with the
// number of live sessions. This cap is what flattens the read cost: MEASURED on the author's box, a
// full read is ~1.8 ms at 35 files but 29.5 ms at 1000, while the same 1000 read under this cap is
// 11.5 ms — the excess being one stat() per candidate for the newest-first sort, which is what keeps
// live sessions from being evicted by dead ones. A truncated read is reported, never silent.
export const CLAUDE_REGISTRY_MAX_FILES = intFromEnv("CLAUDE_REGISTRY_MAX_FILES", 200, { min: 1 });
/**
 * How often local config dirs are re-read. There is no coalescing window and no re-check interval:
 * those belonged to an fs.watch watcher the design removed in favour of this plain interval.
 *
 * 3 s is an OPERATOR DECISION, not a CPU one. A complete read of this machine's three local config
 * dirs measured 1.79 ms (35 files, 14.7 KB) — 0.06 % of one core at this interval, and under a tenth
 * of what the herdr poll beside it already spends on subprocess spawns. What the interval actually
 * buys back is timer wakeups. Remote environments are NOT read here — they are served by the sweep,
 * so this adds no SSH traffic — and a broadcast happens only when a record actually changed.
 */
export const CLAUDE_REGISTRY_POLL_MS = intFromEnv("CLAUDE_REGISTRY_POLL_MS", 3000, { min: 250 });

// Delay before the FIRST statusline sweep after start(). The sweep can't run at t=0 (it would race the
// initial poll and see no rows), so it is kicked once after this short delay — by which point the first
// poll has populated the rows — then runs every RECAP_INTERVAL_MS. Keeps startup renames near-instant.
export const SWEEP_INITIAL_DELAY_MS = intFromEnv("SWEEP_INITIAL_DELAY_MS", 5000, { min: 0 });

// Zombie-tab reaper: when a Claude session exits it leaves a shell-only tab behind (herdr keeps the
// pane, drops the agent). corral closes such tabs automatically once a detached link's tab has
// lingered for this grace window. Set ZOMBIE_REAP_ENABLED=false to turn the reaper off entirely.
//
// The grace must outlast how stale a snapshot's liveness can be, or the reaper closes panes whose
// freshly-spawned Claude it has not polled yet — the old 20000 default against a 30000 poll killed a
// live session 28s after spawn. Clamped to a poll-derived floor: see resolveReapGrace() in
// server/preflight.ts, which raising HERDR_DASH_POLL_MS raises too.
export const ZOMBIE_REAP_ENABLED = process.env.ZOMBIE_REAP_ENABLED !== "false";
export const ZOMBIE_REAP_GRACE_MS = intFromEnv("ZOMBIE_REAP_GRACE_MS", 180_000, { min: 0 });

export const BOARD_DATA_DIR = process.env.BOARD_DATA_DIR ?? CORRAL_HOME;
export const GIT_COMMIT_INTERVAL_MS = 10_000;
export const SPAWN_TIMEOUT_MS = 60_000;

// Pause between successive `claude --resume` launches in a fleet restore (server/fleet-restore.ts).
// A restart can leave dozens of mirrored sessions to resume; firing them back-to-back both spikes
// CPU/disk at once and narrows the window before the poller has seen the new pane, which is exactly
// the staleness spawnSession's join-path idempotency scan can misread as "an unrelated live tab
// already has this name" (see fleet-restore.ts's own comment on that outcome).
export const FLEET_RESTORE_STAGGER_MS = intFromEnv("FLEET_RESTORE_STAGGER_MS", 1500, { min: 0 });

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
// BACKSTOP delay before the server unlinks a brief (server/api.ts). The normal deletion is the
// `rm -f` the launch command runs right after its own `$(cat …)` (server/spawn.ts), so on any pane
// that actually runs the command the file is already gone long before this fires. This timer only
// catches the pane that never ran it, which is why it is generous: `herdr pane run` returns once the
// daemon has injected the command into the pty, NOT once the shell has executed it, so a short timer
// would race a slow shell startup (a heavy rc file is routinely seconds) and delete the brief before
// it was read — losing the whole handoff while the spawn reported success.
export const BRIEF_CLEANUP_DELAY_MS = intFromEnv("BRIEF_CLEANUP_DELAY_MS", 600000, { min: 0 });

// SEC-1: WebSockets bypass same-origin policy, so the upgrade must Origin-allowlist. The Vite dev origin
// is added ONLY outside production — prod serves same-origin from web/dist, and keeping the dev origin in
// prod would be permanent standing attack surface. `assertLoopback` binds the server to 127.0.0.1 anyway.
export const WS_ALLOWED_ORIGINS: readonly string[] = [
  `http://127.0.0.1:${String(PORT)}`,
  `http://localhost:${String(PORT)}`,
  ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:5173"]),
];
