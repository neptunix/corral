import { z } from "zod";

import { BoardFrameSchema, BoardSchema, TaskFrameSchema, TaskSchema } from "../shared/board-schema.ts";
import { AttentionMapSchema, SnapshotSchema } from "../shared/schema.ts";
import { WhoamiResponseSchema } from "../shared/whoami-schema.ts";

export type FetchFn = typeof fetch;

/** A failure the tools can report verbatim: `code` classifies it, `message` is operator-facing. */
export class CorralError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CorralError";
    this.code = code;
  }
}

const ErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string().optional() }),
});

async function request<T>(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit | undefined,
  // The third type param (`unknown`) makes T infer from the schema's OUTPUT side only. Several
  // shared schemas carry `.default()` (input ≠ output — AttentionMapSchema, SessionRow fields);
  // a plain `z.ZodType<T>` would mix the input side into T and the client methods would stop
  // matching their declared `z.infer<…>` return types.
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (err) {
    throw new CorralError(
      "unreachable",
      `corral is not reachable at ${url} (${err instanceof Error ? err.message : String(err)}) — is the server running?`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // A 404 whose body is not even JSON is the version-skew signature, and it is not exotic: the
    // corral server is a long-running process, while this MCP process restarts with every Claude
    // session. `git pull` therefore routinely leaves a new MCP talking to a server that predates
    // these routes, and Hono answers an unknown path with plain text. "non-JSON body (HTTP 404)"
    // told the operator nothing about that; a real 404 from a route that DOES exist (unknown board,
    // unknown pane) carries a JSON error body and never reaches this branch.
    if (res.status === 404) {
      throw new CorralError(
        "server_too_old",
        `the corral server at ${url} does not have this route — it is probably running an older version than this MCP server. Restart corral to pick up the MCP routes.`,
      );
    }
    throw new CorralError("bad_response", `corral returned a non-JSON body (HTTP ${String(res.status)})`);
  }
  if (!res.ok) {
    const parsed = ErrorBodySchema.safeParse(body);
    const code = parsed.success ? parsed.data.error.code : "http_error";
    const message = parsed.success ? parsed.data.error.message ?? code : `HTTP ${String(res.status)}`;
    throw new CorralError(code, message);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new CorralError(
      "bad_response",
      "corral's answer did not match the shape this MCP expects — the two are probably different " +
        "versions. Restart the corral server; if it is already current, this session's MCP is the " +
        `stale one and a fresh session picks up the new build. Details: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function post(body: unknown): RequestInit {
  return { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) };
}

// Every id interpolated into a REST path is model- or caller-supplied text, not a value this module
// controls — a "/" or "?" inside it must stay INSIDE its own path segment rather than being able to
// splice in extra path components or reopen the query string. encodeURIComponent (not encodeURI)
// is required here specifically because it also escapes "/" and "?"; the ids themselves never
// legitimately contain either, so this is a no-op for every real board/task/env/pane id.
function seg(id: string): string {
  return encodeURIComponent(id);
}

export interface TaskPatch {
  readonly title?: string;
  readonly description?: string;
  readonly status?: string;
  readonly priority?: "p0" | "p1" | "p2" | "p3" | null;
}

export interface CorralClient {
  whoami(q: { paneId: string; cwd: string; socket: string | null }): Promise<z.infer<typeof WhoamiResponseSchema>>;
  attention(): Promise<z.infer<typeof AttentionMapSchema>>;
  state(): Promise<z.infer<typeof SnapshotSchema>>;
  /** The board LIST, which the route serves log-free — the picker and the fleet digest read titles
   *  and bindings, never an entry. */
  boards(): Promise<z.infer<typeof BoardFrameSchema>[]>;
  /** One board, for the card read that needs a task's log. The full-list call would carry every other
   *  board's logs into this process for nothing. */
  board(boardId: string): Promise<z.infer<typeof BoardSchema>>;
  appendLog(a: { boardId: string; taskId: string; env: string; paneId: string; text: string }): Promise<z.infer<typeof AppendLogResultSchema>>;
  /** Create a card on a board. The card's provenance (creator, follow-up-of) is written by the route
   *  as the first log entry, from these coordinates — never trusted from a body field. Returns the
   *  new card log-free, like every task-returning route. */
  createTask(a: {
    boardId: string; title: string; env: string; paneId: string;
    description?: string | undefined; priority?: "p0" | "p1" | "p2" | "p3" | null | undefined;
    sourceBoardId?: string | undefined; sourceTaskId?: string | undefined;
  }): Promise<z.infer<typeof TaskFrameSchema>>;
  patchTask(a: { boardId: string; taskId: string; patch: TaskPatch }): Promise<z.infer<typeof TaskSchema>>;
  attach(a: { boardId: string; taskId: string; env: string; paneId: string; name: string }): Promise<void>;
  spawn(a: { boardId: string; taskId: string; env: string; brief: string; name?: string | undefined; model?: string | undefined; remoteControl?: boolean | undefined; targetWorkspaceId?: string | undefined; repo?: string | undefined }): Promise<z.infer<typeof SpawnResultSchema>>;
  closeSession(a: { boardId: string; taskId: string; env: string; paneId: string; sessionId: string | null; deferred?: boolean | undefined }): Promise<void>;
  /** The configured repository NAMES of one environment, from the route the browser's "Into" picker
   *  already uses. Read only when a spawn is being refused, so the happy path pays nothing. */
  spawnTargets(env: string): Promise<string[]>;
}

// The attach route's every non-error path ends in `c.json({ ok: true })` — it never returns a task.
const OkSchema = z.object({ ok: z.boolean() });
// Non-strict, so the route's full SessionLink superset parses and the rest is stripped. The three
// location fields are required: the route returns `{...link, idempotent}`, and a link carries a
// label and a cwd by schema.
const SpawnResultSchema = z.object({
  env: z.string(),
  paneId: z.string(),
  name: z.string(),
  workspaceLabel: z.string(),
  cwdSnapshot: z.string(),
  idempotent: z.boolean(),
});
// What the append route answers with. `logCount` is what the reply reports back, so a session sees
// its entry landed on a card that already holds N.
const AppendLogResultSchema = z.object({
  ok: z.boolean(),
  atMs: z.number(),
  logCount: z.number(),
});
const SpawnTargetsSchema = z.object({
  spaces: z.array(z.object({ workspaceId: z.string(), label: z.string() })).default([]),
  // Deliberately NOT defaulted. `repos: null` means "the names could not be read" to the refusal
  // formatter; defaulting a missing array to `[]` would turn that into the factual claim "this
  // environment has no repositories configured", asserted from absent data.
  repos: z.array(z.object({ name: z.string() })),
});

export function createClient(baseUrl: string, fetchFn: FetchFn = fetch): CorralClient {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    whoami: (q) => {
      const url = new URL(`${base}/api/whoami`);
      url.searchParams.set("paneId", q.paneId);
      url.searchParams.set("cwd", q.cwd);
      if (q.socket !== null) url.searchParams.set("socket", q.socket);
      return request(fetchFn, url.toString(), undefined, WhoamiResponseSchema);
    },
    attention: () => request(fetchFn, `${base}/api/attention`, undefined, AttentionMapSchema),
    state: () => request(fetchFn, `${base}/api/state`, undefined, SnapshotSchema),
    boards: () => request(fetchFn, `${base}/api/boards`, undefined, z.array(BoardFrameSchema)),
    board: (boardId) => request(fetchFn, `${base}/api/boards/${seg(boardId)}`, undefined, BoardSchema),
    appendLog: (a) =>
      request(
        fetchFn,
        `${base}/api/boards/${seg(a.boardId)}/tasks/${seg(a.taskId)}/log`,
        // `at` is deliberately absent: the server stamps it.
        post({ kind: "note", text: a.text, env: a.env, paneId: a.paneId }),
        AppendLogResultSchema,
      ),
    createTask: (a) =>
      request(
        fetchFn,
        `${base}/api/boards/${seg(a.boardId)}/tasks`,
        post({
          title: a.title,
          env: a.env,
          paneId: a.paneId,
          ...(a.description === undefined ? {} : { description: a.description }),
          ...(a.priority === undefined ? {} : { priority: a.priority }),
          ...(a.sourceBoardId === undefined ? {} : { sourceBoardId: a.sourceBoardId }),
          ...(a.sourceTaskId === undefined ? {} : { sourceTaskId: a.sourceTaskId }),
        }),
        TaskFrameSchema,
      ),
    patchTask: (a) =>
      request(
        fetchFn,
        `${base}/api/boards/${seg(a.boardId)}/tasks/${seg(a.taskId)}`,
        { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(a.patch) },
        TaskSchema,
      ),
    attach: async (a) => {
      await request(
        fetchFn,
        `${base}/api/boards/${seg(a.boardId)}/tasks/${seg(a.taskId)}/attach`,
        post({ env: a.env, paneId: a.paneId, name: a.name }),
        OkSchema,
      );
    },
    spawn: (a) =>
      request(
        fetchFn,
        `${base}/api/boards/${seg(a.boardId)}/tasks/${seg(a.taskId)}/spawn`,
        post({
          env: a.env,
          brief: a.brief,
          ...(a.name === undefined ? {} : { name: a.name }),
          ...(a.model === undefined ? {} : { model: a.model }),
          ...(a.remoteControl === undefined ? {} : { remoteControl: a.remoteControl }),
          // Absent, not null: the route reads an omitted key as "resolve the repo to its workspace"
          // and an explicit null as "create a new space".
          ...(a.targetWorkspaceId === undefined ? {} : { targetWorkspaceId: a.targetWorkspaceId }),
          ...(a.repo === undefined ? {} : { repo: a.repo }),
        }),
        SpawnResultSchema,
      ),
    spawnTargets: async (env) => {
      const body = await request(fetchFn, `${base}/api/envs/${seg(env)}/spawn-targets`, undefined, SpawnTargetsSchema);
      return body.repos.map((r) => r.name);
    },
    closeSession: async (a) => {
      const params = new URLSearchParams();
      if (a.sessionId !== null) params.set("sid", a.sessionId);
      if (a.deferred === true) params.set("deferred", "1");
      const q = params.toString();
      const qs = q === "" ? "" : `?${q}`;
      await request(
        fetchFn,
        `${base}/api/boards/${seg(a.boardId)}/tasks/${seg(a.taskId)}/sessions/${seg(a.env)}/${seg(a.paneId)}/close${qs}`,
        post({}),
        OkSchema,
      );
    },
  };
}
