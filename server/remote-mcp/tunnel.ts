import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { quote } from "shell-quote";

import type { HerdrEnv } from "../../environments.ts";
import { sshFlags } from "../ssh-flags.ts";

const run = promisify(execFile);

type RemoteEnv = Extract<HerdrEnv, { readonly kind: "remote" }>;

const PROBE_TIMEOUT_MS = 15_000;
const SETUP_TIMEOUT_MS = 20_000;

export interface TunnelIo {
  /** True when the forwarded socket is present on the remote. */
  probe(env: RemoteEnv, remoteSocket: string): Promise<boolean>;
  /** Create the parent directory and clear a stale socket file, in one remote shell. */
  prepare(env: RemoteEnv, remoteSocket: string): Promise<void>;
  /** Ask the shared connection's master to add the reverse forward. */
  forward(env: RemoteEnv, remoteSocket: string, localSocket: string): Promise<void>;
  /** Ask it to drop that forward again. */
  cancel(env: RemoteEnv, remoteSocket: string, localSocket: string): Promise<void>;
}

// `sh -c` with the path as a positional parameter, never spliced into the script — the same rule
// server/remote-write.ts follows. The path comes from trusted startup config, so this is defence in
// depth rather than the only barrier.
const PROBE_SCRIPT = 'test -S "$1"';
const PREPARE_SCRIPT = 'mkdir -p "$(dirname "$1")" && chmod 700 "$(dirname "$1")" && rm -f "$1"';

function remoteSh(script: string, arg: string): string {
  return quote(["sh", "-c", script, "sh", arg]);
}

export const defaultTunnelIo: TunnelIo = {
  probe: async (env, remoteSocket) => {
    try {
      await run("ssh", [...sshFlags(), env.sshHost, remoteSh(PROBE_SCRIPT, remoteSocket)], { timeout: PROBE_TIMEOUT_MS });
      return true;
    } catch {
      // A non-zero exit means "no socket there"; an ssh failure means the host is unreachable, and
      // both answer the only question this asks — can a shim connect right now? No.
      return false;
    }
  },
  prepare: async (env, remoteSocket) => {
    await run("ssh", [...sshFlags(), env.sshHost, remoteSh(PREPARE_SCRIPT, remoteSocket)], { timeout: SETUP_TIMEOUT_MS });
  },
  forward: async (env, remoteSocket, localSocket) => {
    await run(
      "ssh",
      [...sshFlags(), "-O", "forward", "-R", `${remoteSocket}:${localSocket}`, env.sshHost],
      { timeout: SETUP_TIMEOUT_MS },
    );
  },
  cancel: async (env, remoteSocket, localSocket) => {
    await run(
      "ssh",
      [...sshFlags(), "-O", "cancel", "-R", `${remoteSocket}:${localSocket}`, env.sshHost],
      { timeout: SETUP_TIMEOUT_MS },
    );
  },
};

export type TunnelState = "forwarded" | "already-present" | "unreachable";

/**
 * Drop the forward on shutdown. Best-effort and deliberately quiet: corral is going away, and the
 * shared master may already be gone with it.
 *
 * NOTE what this does NOT do: `ssh -O cancel` stops sshd listening but does not unlink the socket
 * FILE, so the remote is left with a path that now refuses connections instead of one that is
 * absent. The shim reports both as "corral is not connected", and the next `ensureTunnel` clears the
 * file before forwarding again.
 */
export async function cancelTunnel(env: RemoteEnv, localSocket: string, io: TunnelIo = defaultTunnelIo): Promise<void> {
  const remoteSocket = env.mcpSocket;
  if (remoteSocket === undefined) return;
  try {
    await io.cancel(env, remoteSocket, localSocket);
  } catch {
    // Nothing to report: a master that is already gone took the forward with it.
  }
}

/**
 * Bring one environment's reverse forward up, if it is not up already.
 *
 * Probe-then-act, rather than re-requesting the forward on every tick, because the repair is
 * DESTRUCTIVE: `ssh -O cancel` does not unlink the remote socket, and sshd refuses to bind a listen
 * path whose file already exists (the client-side `StreamLocalBindUnlink` is not honoured for remote
 * forwards, and the server-side option of that name defaults to `no`). So the forward can only be
 * re-established by removing the file first — and removing it unconditionally would break every shim
 * connected through a socket that was working perfectly well.
 */
export async function ensureTunnel(env: RemoteEnv, localSocket: string, io: TunnelIo = defaultTunnelIo): Promise<TunnelState> {
  const remoteSocket = env.mcpSocket;
  if (remoteSocket === undefined) return "unreachable";
  if (await io.probe(env, remoteSocket)) return "already-present";
  try {
    await io.prepare(env, remoteSocket);
    await io.forward(env, remoteSocket, localSocket);
    return "forwarded";
  } catch (err) {
    // Expected and recoverable: the host is down, the shared master has not been established yet, or
    // corral's key on that host has not been given the `port-forwarding` option (see ADR 0009). Each
    // is retried on the next tick, and the operator-facing symptom is the shim's own connect error.
    console.error(
      `[remote-mcp] ${env.id}: could not forward ${path.basename(remoteSocket)} — ` +
      (err instanceof Error ? err.message : String(err)),
    );
    return "unreachable";
  }
}
