import { BoardSchema, TaskSchema } from "@shared/board-schema.ts";
import { AttentionMapSchema, SnapshotSchema } from "@shared/schema";
import { WhoamiResponseSchema } from "@shared/whoami-schema.ts";
import { z } from "zod";

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
    throw new CorralError("bad_response", `corral returned a non-JSON body (HTTP ${String(res.status)})`);
  }
  if (!res.ok) {
    const parsed = ErrorBodySchema.safeParse(body);
    const code = parsed.success ? parsed.data.error.code : "http_error";
    const message = parsed.success ? parsed.data.error.message ?? code : `HTTP ${String(res.status)}`;
    throw new CorralError(code, message);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new CorralError("bad_response", parsed.error.message);
  return parsed.data;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function post(body: unknown): RequestInit {
  return { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) };
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
  boards(): Promise<z.infer<typeof BoardSchema>[]>;
  patchTask(a: { boardId: string; taskId: string; patch: TaskPatch }): Promise<z.infer<typeof TaskSchema>>;
  attach(a: { boardId: string; taskId: string; env: string; paneId: string; name: string }): Promise<void>;
  spawn(a: { boardId: string; taskId: string; env: string; brief: string; targetWorkspaceId?: string | undefined }): Promise<{ env: string; paneId: string; name: string }>;
  closeSession(a: { boardId: string; taskId: string; env: string; paneId: string; sessionId: string | null; deferred?: boolean | undefined }): Promise<void>;
}

const OkSchema = z.object({ ok: z.boolean() });
const SpawnResultSchema = z.object({ env: z.string(), paneId: z.string(), name: z.string() });

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
    boards: () => request(fetchFn, `${base}/api/boards`, undefined, z.array(BoardSchema)),
    patchTask: (a) =>
      request(
        fetchFn,
        `${base}/api/boards/${a.boardId}/tasks/${a.taskId}`,
        { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(a.patch) },
        TaskSchema,
      ),
    attach: async (a) => {
      await request(
        fetchFn,
        `${base}/api/boards/${a.boardId}/tasks/${a.taskId}/attach`,
        post({ env: a.env, paneId: a.paneId, name: a.name }),
        OkSchema.or(TaskSchema),
      );
    },
    spawn: (a) =>
      request(
        fetchFn,
        `${base}/api/boards/${a.boardId}/tasks/${a.taskId}/spawn`,
        post({
          env: a.env,
          brief: a.brief,
          ...(a.targetWorkspaceId === undefined ? {} : { targetWorkspaceId: a.targetWorkspaceId }),
        }),
        SpawnResultSchema,
      ),
    closeSession: async (a) => {
      const params = new URLSearchParams();
      if (a.sessionId !== null) params.set("sid", a.sessionId);
      if (a.deferred === true) params.set("deferred", "1");
      const q = params.toString();
      const qs = q === "" ? "" : `?${q}`;
      await request(
        fetchFn,
        `${base}/api/boards/${a.boardId}/tasks/${a.taskId}/sessions/${a.env}/${encodeURIComponent(a.paneId)}/close${qs}`,
        post({}),
        OkSchema,
      );
    },
  };
}
