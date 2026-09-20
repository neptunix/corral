import type { Snapshot } from "@shared/schema";
import type { WhoamiResponse } from "@shared/whoami-schema.ts";

import type { HerdrEnv } from "../../environments.ts";
import type { CorralClient } from "../../mcp/client.ts";
import { createClient } from "../../mcp/client.ts";
import { resolveSelfInEnv, resolveSelfInEnvViaPane } from "../self-in-env.ts";
import type { Storage } from "../storage.ts";
import { createTtlCache } from "../ttl-cache.ts";
import type { PaneIdentity } from "../whoami.ts";
import { buildWhoami } from "../whoami.ts";

export interface SnapshotSource {
  getSnapshot(): Snapshot;
  refreshEnv(envId: string): Promise<void>;
}

export interface PinnedDeps {
  readonly env: HerdrEnv;
  readonly envs: readonly HerdrEnv[];
  readonly poller: SnapshotSource;
  readonly storage: Storage | undefined;
  readonly paneLookup: (env: HerdrEnv, paneId: string) => Promise<PaneIdentity | null>;
}

// The pane lookup costs three ssh commands, so an unknown pane id is not re-asked per request.
const PANE_MISS_TTL_MS = 10_000;

// In process, so the environment never becomes a request parameter the loopback could pass (ADR 0009).
function createPinnedWhoami(deps: PinnedDeps): (paneId: string, cwd: string) => Promise<WhoamiResponse> {
  const { env, envs, poller, storage, paneLookup } = deps;
  const paneMisses = createTtlCache<true>({ ttlMs: PANE_MISS_TTL_MS, maxEntries: 64 });
  return async (paneId, cwd) => {
    let snapshot = poller.getSnapshot();
    let resolution = resolveSelfInEnv({ snapshot, env, paneId, cwd });
    if (!resolution.ok) {
      await poller.refreshEnv(env.id);
      snapshot = poller.getSnapshot();
      resolution = resolveSelfInEnv({ snapshot, env, paneId, cwd });
    }
    // Only not_found escalates: replacing an ambiguous match would drop metrics and hide it.
    if (!resolution.ok && resolution.code === "not_found" && paneMisses.get(paneId) === undefined) {
      resolution = await resolveSelfInEnvViaPane({ env, paneId, lookup: paneLookup });
      if (!resolution.ok) paneMisses.set(paneId, true);
    }
    return buildWhoami({
      resolution,
      envs,
      snapshot,
      boards: storage === undefined ? [] : storage.getAllBoards(),
    });
  };
}

// Spread, not re-implemented: `whoami` is the only call where the environment must be asserted.
export function createPinnedClient(baseUrl: string, deps: PinnedDeps): CorralClient {
  const http = createClient(baseUrl);
  const whoami = createPinnedWhoami(deps);
  return { ...http, whoami: (q) => whoami(q.paneId, q.cwd) };
}
