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
  answersOnRemoteSocket(env: RemoteEnv, remoteSocket: string): Promise<boolean>;
  clearRemoteSocket(env: RemoteEnv, remoteSocket: string): Promise<void>;
  forward(env: RemoteEnv, remoteSocket: string, localSocket: string): Promise<void>;
  cancel(env: RemoteEnv, remoteSocket: string, localSocket: string): Promise<void>;
}

// Connects rather than `test -S`: a cancelled forward and a dead master both leave the file behind.
export const PROBE_SCRIPT =
  'node -e \'const s=require("net").connect(process.argv[1]);' +
  's.on("connect",()=>{s.destroy();process.exit(0)});' +
  's.on("error",()=>process.exit(1));' +
  'setTimeout(()=>{s.destroy();process.exit(1)},3000)\' "$1"';

// Chmods only a directory it created: the configured path may sit in the remote user's home.
const CLEAR_SCRIPT =
  'd=$(dirname "$1"); if [ ! -d "$d" ]; then mkdir -p "$d" && chmod 700 "$d" || exit 1; fi; rm -f "$1"';

// Path passed as a positional parameter, never spliced into the script (as server/remote-write.ts does).
function remoteSh(script: string, arg: string): string {
  return quote(["sh", "-c", script, "sh", arg]);
}

export const defaultTunnelIo: TunnelIo = {
  answersOnRemoteSocket: async (env, remoteSocket) => {
    try {
      await run("ssh", [...sshFlags(), env.sshHost, remoteSh(PROBE_SCRIPT, remoteSocket)], { timeout: PROBE_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  },
  clearRemoteSocket: async (env, remoteSocket) => {
    await run("ssh", [...sshFlags(), env.sshHost, remoteSh(CLEAR_SCRIPT, remoteSocket)], { timeout: SETUP_TIMEOUT_MS });
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

// Best-effort: on shutdown the shared master may already be gone, taking the forward with it.
export async function cancelTunnel(env: RemoteEnv, localSocket: string, io: TunnelIo = defaultTunnelIo): Promise<void> {
  const remoteSocket = env.mcpSocket;
  if (remoteSocket === undefined) return;
  try {
    await io.cancel(env, remoteSocket, localSocket);
  } catch {
    // Nothing to report.
  }
}

// Probes first: re-forwarding means unlinking a socket live shims may be connected through.
export async function ensureTunnel(env: RemoteEnv, localSocket: string, io: TunnelIo = defaultTunnelIo): Promise<TunnelState> {
  const remoteSocket = env.mcpSocket;
  if (remoteSocket === undefined) return "unreachable";
  if (await io.answersOnRemoteSocket(env, remoteSocket)) return "already-present";
  try {
    await io.clearRemoteSocket(env, remoteSocket);
    await io.forward(env, remoteSocket, localSocket);
    return "forwarded";
  } catch (err) {
    // Host down, no shared master yet, or the key lacks `port-forwarding` — all retried next tick.
    console.error(
      `[remote-mcp] ${env.id}: could not forward ${path.basename(remoteSocket)} — ` +
      (err instanceof Error ? err.message : String(err)),
    );
    return "unreachable";
  }
}
