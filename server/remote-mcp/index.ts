import type { HerdrEnv } from "../../environments.ts";
import { guardedInterval } from "../scheduler.ts";
import { SSH_CONTROL_PERSIST_S } from "../ssh-flags.ts";
import type { Storage } from "../storage.ts";
import type { PaneIdentity } from "../whoami.ts";
import { localSocketPath, startEnvListener } from "./listener.ts";
import type { SnapshotSource } from "./pinned-client.ts";
import { cancelTunnel, ensureTunnel, type TunnelIo } from "./tunnel.ts";

export { MCP_SOCKET_DIR, localSocketPath } from "./listener.ts";

type RemoteEnv = Extract<HerdrEnv, { readonly kind: "remote" }>;

function isForwardable(env: HerdrEnv): env is RemoteEnv & { readonly mcpSocket: string } {
  return env.kind === "remote" && env.mcpSocket !== undefined;
}

export interface RemoteMcpOpts {
  readonly envs: readonly HerdrEnv[];
  readonly poller: SnapshotSource;
  readonly storage: Storage | undefined;
  readonly paneLookup: (env: HerdrEnv, paneId: string) => Promise<PaneIdentity | null>;
  readonly baseUrl: string;
  readonly intervalMs: number;
  readonly io?: TunnelIo | undefined;
}

/**
 * Give every remote environment that opted in (`mcpSocket` in the trusted startup config) an MCP
 * surface: a local unix listener the environment's sessions reach through a reverse forward corral
 * holds on its shared ssh connection. See ADR 0009 — the connection is the trust boundary, and which
 * listener a connection arrives on is the whole of the environment's identity.
 *
 * Returns a stop function. An environment whose listener cannot be bound is skipped with a warning
 * rather than taking the server down: the rest of corral works without it, and the operator-visible
 * symptom is confined to that environment's sessions having no corral tools.
 */
export async function startRemoteMcp(opts: RemoteMcpOpts): Promise<() => void> {
  const targets = opts.envs.filter(isForwardable);
  if (targets.length === 0) return () => undefined;

  // `ssh -O forward` speaks to an EXISTING master; it never establishes one. With ControlPersist at
  // 0 the master exits with the command that created it, so by the time the forward is requested
  // there is nothing listening on the control path and every attempt fails with an error that
  // explains none of this. Worth one line at startup, because the symptom is otherwise "remote MCP
  // just doesn't work".
  if (SSH_CONTROL_PERSIST_S === 0) {
    console.error(
      "[remote-mcp] SSH_CONTROL_PERSIST_S is 0, so corral's ssh connection does not outlive a single " +
      "command — the reverse forward has no master to attach to and remote MCP cannot work. Set it above 0.",
    );
  }

  const stops: (() => void)[] = [];
  for (const env of targets) {
    try {
      const listener = await startEnvListener(
        { env, envs: opts.envs, poller: opts.poller, storage: opts.storage, paneLookup: opts.paneLookup },
        opts.baseUrl,
      );
      const local = listener.socketPath;
      const stopTick = guardedInterval(async () => { await ensureTunnel(env, local, opts.io ?? undefined); }, opts.intervalMs);
      stops.push(() => {
        stopTick();
        // Cancel before closing the listener: a forward left registered would point at a socket that
        // no longer exists, so a shim would connect through the tunnel and then be refused, instead
        // of being told plainly that corral is not connected.
        void cancelTunnel(env, local, opts.io ?? undefined).finally(() => listener.close());
      });
      console.warn(`[remote-mcp] ${env.id}: serving ${localSocketPath(env.id)}`);
    } catch (err) {
      console.error(
        `[remote-mcp] ${env.id}: not serving — ${err instanceof Error ? err.message : String(err)}. ` +
        "Sessions on that environment will have no corral tools.",
      );
    }
  }
  return () => { for (const stop of stops) stop(); };
}
