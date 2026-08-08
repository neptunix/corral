import type { CorralClient } from "./client.ts";
import { CorralError } from "./client.ts";
import type { WhoamiResolved, WhoamiTask } from "../shared/whoami-schema.ts";

export interface HerdrContext {
  readonly paneId: string;
  readonly socket: string | null;
  readonly cwd: string;
}

// Empty string and absent are the same "not set" signal for every herdr env var read below —
// normalize both to null so callers never have to special-case "" separately from undefined.
function presentOrNull(v: string | undefined): string | null {
  return v === undefined || v === "" ? null : v;
}

/**
 * The caller's own coordinates, taken from the environment herdr sets in every pane. This process is
 * a child of the Claude process, which runs in the pane, so these are inherited rather than guessed.
 * Returns null when not running inside herdr — the entry point then advertises no tools at all.
 *
 * A whitespace-only pane id (e.g. "   ") is forwarded as-is rather than treated as absent: it is
 * not our job to decide what counts as a valid pane id, only whether one was set at all. The
 * server owns the shape rule and rejects a value that cannot be one ("malformed paneId"), distinct
 * from a well-formed id it simply cannot find (an unresolved, retryable answer).
 */
export function readHerdrEnv(env: NodeJS.ProcessEnv, cwd: string): HerdrContext | null {
  if (presentOrNull(env.HERDR_ENV) === null) return null;
  const paneId = presentOrNull(env.HERDR_PANE_ID);
  if (paneId === null) return null;
  return { paneId, socket: presentOrNull(env.HERDR_SOCKET_PATH), cwd };
}

export interface Identity {
  load(force?: boolean): Promise<WhoamiResolved>;
  /**
   * The bound card, or the standard "not bound" refusal. Returns the WHOLE card rather than just
   * its ids: `WhoamiTask` already carries `boardId`/`taskId`, so every caller that only wanted
   * those is unaffected, while a caller that also needs `columns` (corral_task_update) or
   * `description` (corral_task_read) gets them from the same forced read instead of a second one.
   */
  requireCard(): Promise<WhoamiTask>;
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
      return me.task;
    },
  };
}
