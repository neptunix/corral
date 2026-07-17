import type { Board, BoardState, SessionLink, Task } from "@shared/board-schema";
import type { PaneRead } from "@shared/schema";
import { z } from "zod";

const base = "";

const ErrorBodySchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
    })
    .optional(),
});

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const raw: unknown = await res.json().catch(() => ({}));
    const body = ErrorBodySchema.safeParse(raw);
    const message = body.success ? (body.data.error?.message ?? `HTTP ${String(res.status)}`) : `HTTP ${String(res.status)}`;
    throw new Error(message);
  }
  // res.json() returns Promise<any>; T is caller-specified and trusted
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return res.json();
}

export const api = {
  boards: {
    list: () => req<Board[]>("/api/boards"),
    create: (label: string) =>
      req<Board>("/api/boards", {
        method: "POST",
        body: JSON.stringify({ label }),
      }),
    update: (bid: string, patch: Partial<Pick<Board, "label" | "columns">>) =>
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
        status: string;
        priority?: string | null;
        description?: string;
        repo?: string | null;
      },
    ) =>
      req<Task>(`/api/boards/${bid}/tasks`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (
      bid: string,
      tid: string,
      patch: Partial<
        Pick<Task, "title" | "description" | "status" | "priority" | "repo">
      >,
    ) =>
      req<Task>(`/api/boards/${bid}/tasks/${tid}`, {
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
    // close kills the session's herdr tab but keeps the task→session link (unlike detach, which only
    // unlinks); the session disappears from the next poll and the card renders detached.
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
      req<Task>(`/api/boards/${bid}/tasks/from-session`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    // repo (config key) roots a NEW space; null when joining an existing space.
    spawn: (bid: string, tid: string, env: string, targetWorkspaceId: string | null, repo: string | null) =>
      req<SessionLink & { idempotent: boolean }>(
        `/api/boards/${bid}/tasks/${tid}/spawn`,
        { method: "POST", body: JSON.stringify({ env, targetWorkspaceId, repo }) },
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
};
