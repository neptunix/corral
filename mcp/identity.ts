import type { WhoamiResolved } from "@shared/whoami-schema.ts";

import type { CorralClient } from "./client.ts";
import { CorralError } from "./client.ts";

export interface HerdrContext {
  readonly paneId: string;
  readonly socket: string | null;
  readonly cwd: string;
}

/**
 * The caller's own coordinates, taken from the environment herdr sets in every pane. This process is
 * a child of the Claude process, which runs in the pane, so these are inherited rather than guessed.
 * Returns null when not running inside herdr — the entry point then advertises no tools at all.
 */
export function readHerdrEnv(env: NodeJS.ProcessEnv, cwd: string): HerdrContext | null {
  if (env.HERDR_ENV === undefined) return null;
  const paneId = env.HERDR_PANE_ID;
  if (paneId === undefined || paneId === "") return null;
  return { paneId, socket: env.HERDR_SOCKET_PATH ?? null, cwd };
}

export interface Identity {
  load(force?: boolean): Promise<WhoamiResolved>;
  requireCard(): Promise<{ readonly boardId: string; readonly taskId: string }>;
}

export function createIdentity(client: CorralClient, ctx: HerdrContext): Identity {
  let cached: WhoamiResolved | null = null;

  async function load(force = false): Promise<WhoamiResolved> {
    if (cached !== null && !force) return cached;
    const res = await client.whoami({ paneId: ctx.paneId, cwd: ctx.cwd, socket: ctx.socket });
    if (!res.resolved) throw new CorralError("unresolved", res.reason);
    cached = res;
    return res;
  }

  return {
    load,
    requireCard: async () => {
      // Always force: a bind performed earlier in this session must be visible here.
      const me = await load(true);
      if (me.task === null) {
        throw new CorralError(
          "unbound",
          "this session is not bound to a task — call corral_task_bind first (with no arguments to list open cards)",
        );
      }
      return { boardId: me.task.boardId, taskId: me.task.taskId };
    },
  };
}
