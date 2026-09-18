import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import { CORRAL_HOME, intFromEnv } from "../config.ts";

/**
 * corral shares ONE ssh connection per remote host across every ssh invocation it makes — one-shot
 * herdr/read commands and the interactive live-terminal attach alike — instead of relying on the
 * operator's own `~/.ssh/config` (ControlMaster there only looked shared because it happened to be
 * configured on this machine). `-o` flags passed on the argv always win over ssh_config for that key,
 * so an operator with their own ControlMaster/ControlPath still gets corral's, not theirs. That
 * override is required, not incidental: a later corral feature rides `ssh -O forward` on this same
 * connection, which only works if corral itself knows the ControlPath — it cannot ask ssh_config
 * what path the operator chose.
 */
export const SSH_SOCKET_DIR = path.join(CORRAL_HOME, "ssh");

// %C is ssh's own hash of (local host, remote host, port, user) — short and collision-free, unlike
// spelling those out, which routinely exceeds the ~100-byte unix-domain-socket path limit once
// CORRAL_HOME sits a few directories deep.
const CONTROL_PATH = path.join(SSH_SOCKET_DIR, "%C");

// How long the shared connection lingers after its last client disconnects, so a burst of calls a
// few seconds apart (poller, statusline, recap sweep) reuses one connection instead of paying a new
// handshake each time. This is reuse, not liveness: detecting a master gone stale under a dropped
// network (`ssh -O check`) is explicit YAGNI per the operator's stable-broadband assumption — a hung
// master still surfaces as the per-command timeout firing, exactly as an unshared connection would.
const SSH_CONTROL_PERSIST_S = intFromEnv("SSH_CONTROL_PERSIST_S", 600, { min: 0 });

// %C always expands to a fixed 40-character hex hash, so ONLY the directory prefix can push the full
// path over the unix-domain-socket limit (104 bytes on macOS/BSD, 108 on Linux). 100 leaves margin on
// the tighter of the two for the "/" plus the hash. This can't fail loud through ssh itself — a socket
// path that's too long fails every remote call with the same opaque ssh error — so it's checked and
// warned about once, here, instead.
const CONTROL_PATH_HASH_LEN = 40;
const SAFE_SOCKET_PATH_BUDGET = 100;

let socketDirEnsured = false;

// Idempotent and synchronous, so every flag builder below can call it inline with no `await`. Mode is
// set with an explicit chmod rather than trusting `mkdirSync`'s `mode` option, which the OS applies
// through the process umask and so cannot be relied on to land at exactly 0700.
function ensureSocketDir(): void {
  if (socketDirEnsured) return;
  mkdirSync(SSH_SOCKET_DIR, { recursive: true, mode: 0o700 });
  chmodSync(SSH_SOCKET_DIR, 0o700);
  if (SSH_SOCKET_DIR.length + 1 + CONTROL_PATH_HASH_LEN > SAFE_SOCKET_PATH_BUDGET) {
    console.error(
      `[ssh-flags] CORRAL_HOME (${CORRAL_HOME}) puts the ssh control socket path close to or over the ` +
      "unix-domain-socket length limit — every remote ssh call may fail. Point CORRAL_HOME at a shorter path.",
    );
  }
  socketDirEnsured = true;
}

/** The connection-sharing flags alone — every ssh invocation below folds these in. */
export function sshShareFlags(): string[] {
  ensureSocketDir();
  return [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${CONTROL_PATH}`,
    "-o", `ControlPersist=${String(SSH_CONTROL_PERSIST_S)}`,
  ];
}

/**
 * The ONE definition of the flags for a one-shot ssh call (`buildExec`, transcript/statusline reads,
 * the session registry, the diagnostics remote probe). `ConnectTimeout` only bounds the initial
 * connect — a mux client attaching to an already-running master skips that step entirely — so callers
 * still need their own overall `timeout` on the exec itself; this function does not replace that.
 */
export function sshOneShotFlags(): string[] {
  return [
    "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=yes",
    ...sshShareFlags(),
  ];
}

/**
 * The ONE definition of the flags for the interactive live-terminal attach (`buildAttachSpec`). It
 * DOES share the master: every corral ssh call multiplexes onto the same `ControlPath`, so whichever
 * call happens to establish the connection first — a poll, a statusline read, or the attach itself —
 * makes no difference, and an attach that reuses an already-open connection skips a full handshake
 * before the terminal becomes interactive. `ControlPersist` also means killing the attach's ssh
 * process (the pty-bridge's SIGHUP/SIGKILL reap) only closes that one multiplexed channel, never the
 * shared master. `ServerAliveInterval`/`ServerAliveCountMax` are kept alongside the share flags rather
 * than folded into a single universal flag set: they apply only when THIS invocation is the one that
 * establishes the master, which any of corral's ssh calls could end up being.
 */
export function sshAttachFlags(): string[] {
  return [
    "-o", "ConnectTimeout=8",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-o", "StrictHostKeyChecking=yes",
    ...sshShareFlags(),
  ];
}
