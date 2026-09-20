import type { HerdrEnv } from "../../environments.ts";
import { guardedInterval } from "../scheduler.ts";
import type { Storage } from "../storage.ts";
import type { PaneIdentity } from "../whoami.ts";
import { startEnvListener } from "./listener.ts";
import type { SnapshotSource } from "./pinned-client.ts";
import { cancelTunnel, ensureTunnel } from "./tunnel.ts";

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
}

/**
 * Give every remote environment that opted in (`mcpSocket` in the trusted startup config) an MCP
 * surface: a local unix listener the environment's sessions reach through a reverse forward corral
 * holds on its shared ssh connection. See ADR 0009 — the connection is the trust boundary, and which
 * listener a connection arrives on is the whole of the environment's identity.
 *
 * Returns an AWAITABLE stop function — dropping the forward is an ssh round trip, so a caller that
 * fires it and exits in the same tick never drops anything. An environment whose listener cannot be bound is skipped with a warning
 * rather than taking the server down: the rest of corral works without it, and the operator-visible
 * symptom is confined to that environment's sessions having no corral tools.
 */
export async function startRemoteMcp(opts: RemoteMcpOpts): Promise<() => Promise<void>> {
  const targets = opts.envs.filter(isForwardable);
  if (targets.length === 0) return () => Promise.resolve();


  let stopping = false;
  // Read through a function: after `if (stopping) return`, TypeScript narrows the flag to false for
  // the rest of the block and flags the second check as dead — it cannot see that the `await` between
  // them is exactly when shutdown lands.
  const isStopping = (): boolean => stopping;
  const shutdowns: (() => Promise<void>)[] = [];
  for (const env of targets) {
    try {
      const listener = await startEnvListener(
        { env, envs: opts.envs, poller: opts.poller, storage: opts.storage, paneLookup: opts.paneLookup },
        opts.baseUrl,
      );
      const local = listener.socketPath;
      // `up` starts unknown, so the FIRST outcome is always announced. After that only changes are:
      // a tick every 30s that says the same thing is noise an operator learns to scroll past, and the
      // transition is the whole signal — this is the only place corral reports that an environment's
      // sessions have lost (or regained) their tools.
      let up: boolean | null = null;
      const tick = async (): Promise<void> => {
        // The tick is guarded against overlapping ITSELF, not against shutdown: one already in flight
        // when the server stops would otherwise re-forward onto a listener that is closing, leaving a
        // registered forward pointing at nothing.
        if (isStopping()) return;
        const state = await ensureTunnel(env, local);
        if (isStopping()) return;
        const nowUp = state !== "unreachable";
        if (nowUp !== up) {
          console.warn(
            nowUp
              ? `[remote-mcp] ${env.id}: tunnel up — sessions there have corral tools.`
              : `[remote-mcp] ${env.id}: tunnel down — sessions there have no corral tools until it is back.`,
          );
          up = nowUp;
        }
      };
      const stopTick = guardedInterval(tick, opts.intervalMs);
      shutdowns.push(async () => {
        stopTick();
        // Cancel before closing the listener: a forward left registered would point at a socket that
        // no longer exists, so a shim would connect through the tunnel and then be refused, instead
        // of being told plainly that corral is not connected.
        await cancelTunnel(env, local);
        await listener.close();
      });
      console.warn(`[remote-mcp] ${env.id}: serving ${local}`);
    } catch (err) {
      console.error(
        `[remote-mcp] ${env.id}: not serving — ${err instanceof Error ? err.message : String(err)}. ` +
        "Sessions on that environment will have no corral tools.",
      );
    }
  }
  return async () => {
    stopping = true;
    await Promise.all(shutdowns.map((stop) => stop()));
  };
}
