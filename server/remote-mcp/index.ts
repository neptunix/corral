import type { HerdrEnv } from "../../environments.ts";
import { guardedInterval } from "../scheduler.ts";
import type { Storage } from "../storage.ts";
import type { PaneIdentity } from "../whoami.ts";
import { startEnvListener } from "./listener.ts";
import type { SnapshotSource } from "./pinned-client.ts";
import type { TunnelStatus } from "./status.ts";
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
  readonly status: TunnelStatus;
  readonly now?: () => number;
}

// An MCP surface for remote environments that opted in with `mcpSocket` (ADR 0009).
export async function startRemoteMcp(opts: RemoteMcpOpts): Promise<() => Promise<void>> {
  const targets = opts.envs.filter(isForwardable);
  if (targets.length === 0) return () => Promise.resolve();
  const now = opts.now ?? Date.now;

  let stopping = false;
  // Through a function, or TypeScript narrows the flag to false across the await between checks.
  const isStopping = (): boolean => stopping;
  const shutdowns: (() => Promise<void>)[] = [];
  for (const env of targets) {
    try {
      const listener = await startEnvListener(
        { env, envs: opts.envs, poller: opts.poller, storage: opts.storage, paneLookup: opts.paneLookup },
        opts.baseUrl,
      );
      const local = listener.socketPath;
      // Null so the first outcome is announced; after that only transitions are.
      let up: boolean | null = null;
      const tick = async (): Promise<void> => {
        // guardedInterval guards against overlap, not against shutdown landing mid-tick.
        if (isStopping()) return;
        const state = await ensureTunnel(env, local);
        if (isStopping()) return;
        const nowUp = state !== "unreachable";
        opts.status.record(env.id, { up: nowUp, at: now() });
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
        // Before closing: a forward left registered answers and then refuses, instead of being absent.
        await cancelTunnel(env, local);
        await listener.close();
      });
      console.warn(`[remote-mcp] ${env.id}: serving ${local}`);
    } catch (err) {
      opts.status.record(env.id, { up: false, at: now() });
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
