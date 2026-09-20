import type { Snapshot } from "@shared/schema";
import type { WhoamiResponse } from "@shared/whoami-schema.ts";

import type { HerdrEnv } from "../../environments.ts";
import type { CorralClient } from "../../mcp/client.ts";
import { createClient } from "../../mcp/client.ts";
import { resolveSelfInEnv, resolveSelfInEnvViaPane } from "../self-in-env.ts";
import type { Storage } from "../storage.ts";
import type { PaneIdentity } from "../whoami.ts";
import { buildWhoami } from "../whoami.ts";

/**
 * The two things identity resolution needs from the poller, named as their own shape rather than
 * taken as the whole `Poller`. The real poller satisfies it structurally, and a caller (or a test)
 * that has only a snapshot does not have to fake nine other methods to say so.
 */
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

/**
 * Identity for a caller on a pinned environment, answered IN PROCESS rather than through
 * `/api/whoami`.
 *
 * The tools are written against `CorralClient`, and every one of their other calls is already
 * addressed by the ids `whoami` hands back — the card, and `env`/`paneId` taken from the resolved
 * session — so `whoami` is the ONE call where the environment has to be asserted. Answering it here
 * keeps that assertion where it is a closure variable set when the listener was created, and out of
 * the REST API entirely: there is no `?env=` parameter for anything on the corral host's loopback to
 * pass, which is the difference between a boundary and a convention. Everything else falls through
 * to the same HTTP client a local session uses.
 *
 * The two escalating recoveries mirror the `/api/whoami` route's, and for the same reason: a session
 * is told to call this first, so an unresolved answer usually means corral has not caught up with a
 * pane created seconds ago, not that the pane is bogus.
 */
export function createPinnedWhoami(deps: PinnedDeps): (paneId: string, cwd: string) => Promise<WhoamiResponse> {
  const { env, envs, poller, storage, paneLookup } = deps;
  return async (paneId, cwd) => {
    let snapshot = poller.getSnapshot();
    let resolution = resolveSelfInEnv({ snapshot, env, paneId, cwd });
    if (!resolution.ok) {
      await poller.refreshEnv(env.id);
      snapshot = poller.getSnapshot();
      resolution = resolveSelfInEnv({ snapshot, env, paneId, cwd });
    }
    // Only a not_found escalates: an ambiguous match already found real rows, and replacing them
    // with a synthesized one would drop the caller's metrics AND hide the ambiguity.
    if (!resolution.ok && resolution.code === "not_found") {
      resolution = await resolveSelfInEnvViaPane({ env, paneId, lookup: paneLookup });
    }
    return buildWhoami({
      resolution,
      envs,
      snapshot,
      boards: storage === undefined ? [] : storage.getAllBoards(),
    });
  };
}

/**
 * The HTTP client every tool already uses, with `whoami` replaced by the in-process, environment-
 * pinned answer above. Spread rather than re-implemented: the remaining calls are the same routes
 * with the same Zod validation, and a second implementation of them would be a second thing to keep
 * in step with the server.
 */
export function createPinnedClient(baseUrl: string, deps: PinnedDeps): CorralClient {
  const http = createClient(baseUrl);
  const whoami = createPinnedWhoami(deps);
  return { ...http, whoami: (q) => whoami(q.paneId, q.cwd) };
}
