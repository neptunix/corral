import type { Board, BoardFrame, BoardState, SessionLink, Task, TaskFrame } from "@shared/board-schema";
import { BoardSchema } from "@shared/board-schema";
import type { DiagnosticsSnapshot } from "@shared/diagnostics-schema";
import { DiagnosticsSnapshotSchema } from "@shared/diagnostics-schema";
import type { PaneRead } from "@shared/schema";
import { z } from "zod";

const base = "";

const ErrorBodySchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

/**
 * A refusal that kept the server's `error.code`. Every route already sends one; the client used to
 * drop it and leave callers matching on prose. A caller that must tell one refusal from another —
 * "the pane is already gone" from "the pane now belongs to someone else" — needs the code.
 */
export class ApiError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const raw: unknown = await res.json().catch(() => ({}));
    const body = ErrorBodySchema.safeParse(raw);
    const message = body.success ? (body.data.error?.message ?? `HTTP ${String(res.status)}`) : `HTTP ${String(res.status)}`;
    throw new ApiError(message, body.success ? (body.data.error?.code ?? null) : null);
  }
  // res.json() returns Promise<any>; T is caller-specified and trusted
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return res.json();
}

// The spawn body, built by the caller. An eighth positional argument whose neighbors are already
// `null` is past the point of readability, so this route takes one object. Optional keys are
// OMITTED, never sent as null/false: the route reads absence as "off" for remoteControl and as
// "inherit" for model.
export interface SpawnRequestBody {
  readonly env: string;
  readonly targetWorkspaceId: string | null;
  readonly repo: string | null;
  readonly model?: string;
  readonly remoteControl?: true;
  readonly startCommand?: string;
}

export const api = {
  boards: {
    // The LIST route serves frames (server/api.ts) — every task-shaped response but
    // `GET /api/boards/:bid` is log-free, and `req` is an unvalidated generic, so this
    // declaration is the only thing that says so on this side.
    list: () => req<BoardFrame[]>("/api/boards"),
    // The ONE route that carries a card's log, fetched when a card's Log tab opens. Parsed rather
    // than trusted: this is the boundary every entry another session wrote comes through.
    get: async (bid: string): Promise<Board> => BoardSchema.parse(await req<unknown>(`/api/boards/${bid}`)),
    create: (label: string) =>
      req<Board>("/api/boards", {
        method: "POST",
        body: JSON.stringify({ label }),
      }),
    update: (bid: string, patch: Partial<Pick<Board, "label" | "columns" | "spawnPresets" | "defaultSpawnPresetId">>) =>
      req<Board>(`/api/boards/${bid}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    delete: (bid: string) =>
      req<{ ok: boolean }>(`/api/boards/${bid}`, { method: "DELETE" }),
  },
  tasks: {
    create: (
      bid: string,
      data: {
        title: string;
        // Omitted → the server resolves the board's landing column (mirrors fromSession below).
        status?: string;
        priority?: string | null;
        description?: string;
      },
    ) =>
      req<TaskFrame>(`/api/boards/${bid}/tasks`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (
      bid: string,
      tid: string,
      patch: Partial<
        Pick<Task, "title" | "description" | "status" | "priority">
      >,
    ) =>
      req<TaskFrame>(`/api/boards/${bid}/tasks/${tid}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    delete: (bid: string, tid: string) =>
      req<{ ok: boolean }>(`/api/boards/${bid}/tasks/${tid}`, {
        method: "DELETE",
      }),
    // attach binds an existing (live, unassigned) session to a task — the Unassigned card's "Assign to
    // task" action (a card holds 0..n sessions); detach removes one session link via the ✕ on a session
    // row (the session itself lives on, becoming unassigned again). attach persists the stable sessionId.
    attach: (bid: string, tid: string, env: string, paneId: string) =>
      req<{ ok: boolean }>(`/api/boards/${bid}/tasks/${tid}/attach`, {
        method: "POST",
        body: JSON.stringify({ env, paneId }),
      }),
    detach: (bid: string, tid: string, env: string, paneId: string, sessionId: string | null) =>
      req<{ ok: boolean }>(`/api/boards/${bid}/tasks/${tid}/detach`, {
        method: "POST",
        body: JSON.stringify({ env, paneId, sessionId }),
      }),
    // close kills the session's pane via herdr pane close (which cascades pane → tab → workspace) but
    // keeps the task→session link (unlike detach, which only unlinks); the session disappears from the
    // next poll and the card renders detached.
    close: (bid: string, tid: string, env: string, paneId: string, sessionId: string | null) =>
      req<{ ok: boolean }>(
        `/api/boards/${bid}/tasks/${tid}/sessions/${env}/${paneId}/close${sessionId !== null && sessionId !== "" ? `?sid=${sessionId}` : ""}`,
        { method: "POST" },
      ),
    // resume restarts a stopped Claude session (`claude --resume <uuid>`) and rebinds the link to the
    // new pane/tab/workspace, keeping the same sessionId.
    resume: (bid: string, tid: string, env: string, paneId: string, sessionId: string | null) =>
      req<SessionLink>(
        `/api/boards/${bid}/tasks/${tid}/sessions/${env}/${paneId}/resume${sessionId !== null && sessionId !== "" ? `?sid=${sessionId}` : ""}`,
        { method: "POST" },
      ),
    fromSession: (
      bid: string,
      data: {
        title: string;
        env: string;
        paneId: string;
        name: string;
        tabLabel: string;
        workspaceLabel: string;
      },
    ) =>
      req<TaskFrame>(`/api/boards/${bid}/tasks/from-session`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    spawn: (bid: string, tid: string, body: SpawnRequestBody) =>
      req<SessionLink & { idempotent: boolean }>(
        `/api/boards/${bid}/tasks/${tid}/spawn`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    move: (bid: string, tid: string, toBoardId: string) =>
      req<{ ok: boolean }>(`/api/boards/${bid}/tasks/${tid}/move`, {
        method: "POST",
        body: JSON.stringify({ toBoardId }),
      }),
  },
  envs: {
    // Spawn "Into" picker data: existing herdr spaces to join + the env's configured repos to create a
    // new space from. See GET /api/envs/:env/spawn-targets.
    spawnTargets: (env: string) =>
      req<{ spaces: { workspaceId: string; label: string }[]; repos: { name: string }[] }>(
        `/api/envs/${env}/spawn-targets`,
      ),
  },
  state: (boardId: string) =>
    req<BoardState>(`/api/state?board=${boardId}`),
  sessions: {
    // Read-only pane snapshot (herdr `pane read`, no takeover) → the Unassigned mini-terminal preview.
    // `signal` lets the caller abort an in-flight read when its card unmounts (leaving the view).
    read: (env: string, paneId: string, lines = 50, signal?: AbortSignal) =>
      req<PaneRead>(
        `/api/sessions/${env}/${paneId}/read?lines=${String(lines)}`,
        signal !== undefined ? { signal } : undefined,
      ),
    // Transcript-derived last-activity timestamp for a detached session row (server TTL-caches it).
    lastActive: (env: string, sessionId: string) =>
      req<{ lastActive: number | null }>(`/api/sessions/${env}/${sessionId}/last-active`),
  },
  theme: {
    // Sync the resolved dashboard theme into each local Claude config's custom `corral` theme.
    set: (mode: "light" | "dark") =>
      req<{ ok: boolean; updated: number }>("/api/theme", {
        method: "POST",
        body: JSON.stringify({ mode }),
      }),
  },
  diagnostics: {
    // Parsed here rather than trusted: `req` returns the body unvalidated, and this is a boundary.
    // The route answers 503 when diagnostics are unwired, which `req` turns into a thrown Error —
    // the caller renders that as an operator-facing line, never as silence.
    refresh: async (): Promise<DiagnosticsSnapshot> =>
      DiagnosticsSnapshotSchema.parse(await req<unknown>("/api/diagnostics/refresh", { method: "POST" })),
  },
};
