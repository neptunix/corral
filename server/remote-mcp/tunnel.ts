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
  /** True when something ANSWERS on the forwarded socket. */
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

// CONNECTS, rather than testing that a file is there. The two differ in exactly the case this loop
// exists for: `ssh -O cancel`, and a master that dies, both leave the socket FILE on the remote while
// nothing listens behind it any more. `test -S` calls that healthy forever, so the repair would never
// run and the environment would stay dark until corral was restarted. Node is already this feature's
// requirement on the remote — it is what runs the shim — so using it here adds no new dependency.
export const PROBE_SCRIPT =
  'node -e \'const s=require("net").connect(process.argv[1]);' +
  's.on("connect",()=>{s.destroy();process.exit(0)});' +
  's.on("error",()=>process.exit(1));' +
  'setTimeout(()=>{s.destroy();process.exit(1)},3000)\' "$1"';

// Only sets the mode on a directory it CREATES. An unconditional `chmod 700 "$(dirname "$1")"` acts
// on whatever the operator's configured path happens to sit in: one level too shallow and it silently
// locks down the remote home directory, or fails on a shared /tmp and takes the rest of the chain
// down with it. The socket sshd creates is 0600 regardless — the directory mode is defence in depth,
// not the control.
const PREPARE_SCRIPT =
  'd=$(dirname "$1"); if [ ! -d "$d" ]; then mkdir -p "$d" && chmod 700 "$d" || exit 1; fi; rm -f "$1"';

function remoteSh(script: string, arg: string): string {
  return quote(["sh", "-c", script, "sh", arg]);
}

export const defaultTunnelIo: TunnelIo = {
  probe: async (env, remoteSocket) => {
    try {
      await run("ssh", [...sshFlags(), env.sshHost, remoteSh(PROBE_SCRIPT, remoteSocket)], { timeout: PROBE_TIMEOUT_MS });
      return true;
    } catch {
      // A non-zero exit means nothing answered there; an ssh failure means the host is unreachable,
      // and both answer the only question this asks — can a shim connect right now? No.
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
 * DESTRUCTIVE (and the probe therefore has to be a real connect — see PROBE_SCRIPT): `ssh -O cancel` does not unlink the remote socket, and sshd refuses to bind a listen
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
