import {
  type Board, type BoardState, type EnrichedTask,
  type GlobalState, type SessionLink, type Task,
  ColumnSchema,
  DEFAULT_COLUMNS,
  generateTaskId,
  nowSecs,
  slugifyBoardId,
  sortTasks,
} from "@shared/board-schema.ts";
import type { AttentionMap, PaneRead, SessionRow, Snapshot } from "@shared/schema";
import { MoveTaskRequestSchema, UPLOAD_MAX_BYTES } from "@shared/schema";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import { READ_CACHE_TTL_MS, SPAWN_TIMEOUT_MS, UPLOAD_ROOT, WS_ALLOWED_ORIGINS } from "../config.ts";
import type { HerdrEnv } from "../environments.ts";
import { syncClaudeThemeBase, ThemeModeSchema } from "./claude-theme.ts";
import { closePane, listWorkspaces, readPane, tabClose, type ReadFn } from "./herdr.ts";
import { isLoopbackHost } from "./host-guard.ts";
import type { Poller } from "./poller.ts";
import { isSessionBound, resolveLinkIndex } from "./session-binding.ts";
import { sanitizeSlug } from "./spawn.ts";
import type { SpawnOpts, SpawnResult } from "./spawn.ts";
import { aggregateAccounts } from "./statusline.ts";
import type { Storage } from "./storage.ts";
import { readLastActivity } from "./transcript.ts";
import { createTtlCache } from "./ttl-cache.ts";
import { writeUploadFile } from "./uploads.ts";
import { PANE_RE } from "./ws-attach-guard.ts";

const BID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TID_RE = /^t_[A-Za-z0-9_-]{7}$/;
// herdr workspace ids (e.g. "w8", "w6555cedb91c1d3"). Must not start with '-' (option-injection into
// `--workspace <id>`); matches the BID_RE/TID_RE/PANE_RE guard discipline for client-supplied ids.
const WS_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LAST_ACTIVE_TTL_MS = 60_000;
// Spawn tab-name suffixes: a task's Nth spawned session gets tab `${slug}-<letter>` (a human-readable
// label so a task's sessions are distinguishable). a–z is a soft ceiling; attached sessions don't
// consume a letter and are unbounded. Revisit if a task ever needs more than 26 spawned sessions.
const SPAWN_SUFFIXES = Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i));

export type SpawnFn = (opts: SpawnOpts) => Promise<SpawnResult>;

// ---------- board/task helpers ----------

function buildUnassigned(storage: Storage | undefined, snapshot: Snapshot): SessionRow[] {
  if (storage === undefined) return [];
  const allBoards = storage.getAllBoards();
  const assignedPanes = new Set<string>();
  const assignedSessions = new Set<string>();
  for (const board of allBoards) {
    for (const task of board.tasks) {
      for (const link of task.sessions) {
        // Keep this pool the complement of buildBoardState's binding — a live session is unassigned iff no
        // card binds it (holds while live session UUIDs are unique per env, the same assumption
        // buildBoardState's bySession index already makes). A link WITH a sessionId binds that UUID's live
        // row, NOT whatever now holds its stored paneId, so it claims ONLY by sessionId: also claiming the
        // paneId would hide a same-pane `/new` replacement (pane keeps its id, gets a NEW uuid; the stale
        // link resolves by sessionId → detached). Churn (stale paneId, stable uuid at a new pane) stays
        // excluded. A link WITHOUT a sessionId is legacy/best-effort → claim by paneId, as buildBoardState
        // binds it. (A live row whose sessionId is briefly null mid-`/new` surfaces to the pool by design.)
        if (link.sessionId !== null && link.sessionId !== "") assignedSessions.add(`${link.env}:${link.sessionId}`);
        else assignedPanes.add(`${link.env}:${link.paneId}`);
      }
    }
  }
  return snapshot.sessions.filter((s) =>
    !assignedPanes.has(`${s.env}:${s.paneId}`) &&
    (s.sessionId === null || !assignedSessions.has(`${s.env}:${s.sessionId}`)));
}

function buildBoardState(board: Board, storage: Storage, snapshot: Snapshot, attention: AttentionMap): BoardState {
  const liveMap = new Map<string, SessionRow>();
  const bySession = new Map<string, SessionRow>();
  for (const s of snapshot.sessions) {
    liveMap.set(`${s.env}:${s.paneId}`, s);
    // Index by the stable Claude UUID so a stale-paneId link can resolve to its current pane.
    if (s.sessionId !== null && s.sessionId !== "") bySession.set(`${s.env}:${s.sessionId}`, s);
  }

  const enrichedTasks: EnrichedTask[] = sortTasks(board.tasks).map((task) => ({
    ...task,
    sessions: task.sessions.map((link) => {
      // Resolve the live row. When the link carries a stable sessionId, TRUST IT over the stored
      // paneId: a herdr restart reassigns paneIds, so the stored paneId may now belong to a *different*
      // session — a paneId hit whose sessionId disagrees is a stale reuse, not ours. So we take the
      // paneId hit only when it has no sessionId to contradict us; otherwise (miss, or hit with a
      // mismatched id) we resolve by the sessionId index and override the enriched paneId with the live
      // row's current one. A sessionId that resolves to nothing → detached (our session is gone), never
      // mis-bound to whoever now holds the pane. Without a sessionId we fall back to the plain paneId
      // hit (best-effort, legacy links). Non-destructive: the stored link is untouched (the reconciler
      // owns write-side backfill); we only heal what we serve. paneId is NOT unique within a task: after
      // a same-pane `/new`, a detached link (old uuid) and a live link (new uuid) both enrich to the
      // reused paneId. React-key uniqueness rests on TaskCard's sessionId-inclusive key
      // (web/src/components/TaskCard.tsx), and every paneId-keyed write resolves the specific link by
      // sessionId (server/session-binding.ts).
      let live = liveMap.get(`${link.env}:${link.paneId}`);
      let paneId = link.paneId;
      if (link.sessionId !== null && link.sessionId !== "" && live?.sessionId !== link.sessionId) {
        const healed = bySession.get(`${link.env}:${link.sessionId}`);
        live = healed;
        paneId = healed !== undefined ? healed.paneId : link.paneId;
      }
      return {
        ...link,
        paneId,
        // Backfill empty labels from the live session row (a session attached via drag before the
        // write-time enrichment landed stored blank labels). `name` is shown only on a DETACHED card
        // ("⚠ {name}"), where `live` is undefined — so it can never come from `live`; fall back to
        // paneId, which also heals records persisted with an empty name before this fix.
        tabLabel: link.tabLabel !== "" ? link.tabLabel : (live?.tab ?? ""),
        workspaceLabel: link.workspaceLabel !== "" ? link.workspaceLabel : (live?.workspace ?? ""),
        name: link.name !== "" ? link.name : link.paneId,
        live: live !== undefined
          ? { status: live.status, model: live.statusline?.model ?? null,
              ctxPct: live.statusline?.ctx.pct !== null && live.statusline?.ctx.pct !== undefined
                ? String(live.statusline.ctx.pct) : null,
              detached: false, recap: live.recap, recapAt: live.recapAt, statusline: live.statusline }
          : { status: "unknown", model: null, ctxPct: null, detached: true,
              recap: null, recapAt: null, statusline: null },
      };
    }),
  }));

  return {
    board,
    tasks: enrichedTasks,
    unassigned: buildUnassigned(storage, snapshot),
    envs: snapshot.envs,
    attention,
    accounts: aggregateAccounts(snapshot.sessions),
  };
}

// ---------- request body schemas ----------

const CreateBoardBodySchema = z.object({
  label: z.string().min(1),
});

const PatchBoardBodySchema = z.object({
  label: z.string().min(1).optional(),
  columns: z.array(ColumnSchema).optional(),
});

const CreateTaskBodySchema = z.object({
  title: z.string().min(1),
  status: z.string(),
  priority: z.enum(["p0", "p1", "p2", "p3"]).nullable().optional(),
  description: z.string().optional(),
  repo: z.string().nullable().optional(),
});

const PatchTaskBodySchema = z.object({
  title: z.string().min(1).optional(),
  status: z.string().optional(),
  priority: z.enum(["p0", "p1", "p2", "p3"]).nullable().optional(),
  description: z.string().optional(),
  repo: z.string().nullable().optional(),
});

const AttachBodySchema = z.object({
  env: z.string(),
  paneId: z.string(),
  tabId: z.string().default(""),
  tabLabel: z.string().default(""),
  workspaceId: z.string().default(""),
  workspaceLabel: z.string().default(""),
  name: z.string().default(""),
  cwdSnapshot: z.string().default(""),
});

const DetachBodySchema = z.object({
  env: z.string(),
  paneId: z.string(),
  // Which of possibly-several same-pane links to unlink. Omitted by legacy callers → null → paneId
  // resolution (+ churn-heal), the prior behavior.
  sessionId: z.string().nullable().default(null),
});

const FromSessionBodySchema = z.object({
  title: z.string().min(1),
  status: z.string().default("todo"),
  priority: z.enum(["p0", "p1", "p2", "p3"]).nullable().optional(),
  description: z.string().optional(),
  repo: z.string().nullable().optional(),
  env: z.string(),
  paneId: z.string(),
  tabId: z.string().default(""),
  tabLabel: z.string().default(""),
  workspaceId: z.string().default(""),
  workspaceLabel: z.string().default(""),
  name: z.string().default(""),
  cwdSnapshot: z.string().default(""),
});

export function createApi(opts: {
  poller: Poller;
  envs: readonly HerdrEnv[];
  read?: ReadFn;
  storage?: Storage;
  spawn?: SpawnFn;
  listWorkspaces?: (env: HerdrEnv) => Promise<{ workspace_id: string; label: string }[]>;
  lastActivity?: (env: HerdrEnv, sessionId: string) => Promise<number | null>;
  closeTab?: (env: HerdrEnv, tabId: string) => Promise<void>;
  spawnTimeoutMs?: number; // injectable so the timeout-cleanup path is testable without a 60s wait
  allowedOrigins?: readonly string[]; // Origin allowlist for the file-upload route (default WS_ALLOWED_ORIGINS)
  uploadRoot?: string; // drop-upload temp root (injectable so tests write to a scratch dir)
}): Hono {
  const read = opts.read ?? readPane;
  const listWs = opts.listWorkspaces ?? listWorkspaces;
  const lastActivity = opts.lastActivity ?? readLastActivity;
  const closeTab = opts.closeTab ?? tabClose;
  const spawnTimeoutMs = opts.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS;
  const allowedOrigins = opts.allowedOrigins ?? WS_ALLOWED_ORIGINS;
  const uploadRoot = opts.uploadRoot ?? UPLOAD_ROOT;
  // Last-active timestamps (transcript-derived); caches `null` too (no transcript). Bounded + TTL'd.
  const laCache = createTtlCache<number | null>({ ttlMs: LAST_ACTIVE_TTL_MS });
  // #4: coalesce sub-second /read bursts (each is a herdr/SSH round-trip). Success-only; keyed by the
  // CLAMPED lines so distinct line counts stay independent.
  const readCache = createTtlCache<PaneRead>({ ttlMs: READ_CACHE_TTL_MS });
  const app = new Hono();

  // Anti-DNS-rebinding (SEC): the loopback bind is the only access control, but a rebound page becomes
  // same-origin and could drive the whole API. Reject any request whose Host is PRESENT and non-loopback
  // (the rebinding vector — a browser always sends its own Host and cannot forge/omit it). A missing
  // Host is not a browser and thus not a rebinding attack (some local CLI/HTTP-1.0 clients omit it), so
  // it's allowed. Mounted first so it covers every route below. The WS attach upgrade is guarded
  // separately at the raw Node `upgrade` handler (origin-allowlisted), so this middleware never sees it.
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (host !== undefined && host !== "" && !isLoopbackHost(host)) {
      return c.json({ error: { code: "forbidden", message: "non-loopback Host rejected" } }, 403);
    }
    return next();
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  // Web theme toggle → flip the `base` of `themes/corral.json` in each LOCAL env's Claude config dir,
  // so a session that selected `custom:corral` follows the dashboard's light/dark. Local only: remote
  // dirs live on another host and would need an SSH write — out of scope, theme sync stays local FS.
  app.post("/api/theme", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: { code: "validation", message: "invalid JSON" } }, 400); }
    const parsed = z.object({ mode: ThemeModeSchema }).safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "validation", message: "mode must be 'light' or 'dark'" } }, 400);
    const dirs = [...new Set(opts.envs.filter((e) => e.kind === "local").flatMap((e) => [...e.claudeConfigDirs]))];
    const updated = await syncClaudeThemeBase(dirs, parsed.data.mode);
    return c.json({ ok: true, updated });
  });

  app.get("/api/state", (c) => {
    const boardId = c.req.query("board");
    if (boardId !== undefined && opts.storage !== undefined) {
      const board = opts.storage.getBoard(boardId);
      if (board === null) return c.json({ error: { code: "not_found" } }, 404);
      return c.json(buildBoardState(board, opts.storage, opts.poller.getSnapshot(), opts.poller.getAttention()));
    }
    return c.json(opts.poller.getSnapshot());
  });

  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      const boardId = new URL(c.req.url).searchParams.get("board") ?? undefined;
      let writing = false;

      // Every frame must parse under the client's StreamFrameSchema (useEventSource silently drops
      // frames that don't). No/unknown board → the GlobalState shape, NOT a bare Snapshot, so the
      // attention feed and unassigned list keep updating on that view.
      function buildPayload(s: Snapshot): BoardState | GlobalState {
        if (boardId !== undefined && opts.storage !== undefined) {
          const board = opts.storage.getBoard(boardId);
          if (board !== null) return buildBoardState(board, opts.storage, s, opts.poller.getAttention());
        }
        return { unassigned: buildUnassigned(opts.storage, s), envs: s.envs, attention: opts.poller.getAttention(), accounts: aggregateAccounts(s.sessions) };
      }

      const send = (s: Snapshot): void => {
        if (writing) return;
        writing = true;
        void stream
          .writeSSE({ data: JSON.stringify(buildPayload(s)) })
          .catch(() => {
            unsubscribe();
          })
          .finally(() => {
            writing = false;
          });
      };
      const unsubscribe = opts.poller.onSnapshot(send);
      stream.onAbort(unsubscribe);
      send(opts.poller.getSnapshot());
      while (!stream.aborted) await stream.sleep(30000);
    }),
  );

  app.delete("/api/sessions/:env/:paneId", async (c) => {
    const env = opts.envs.find((e) => e.id === c.req.param("env"));
    if (!env) return c.json({ error: { code: "validation", message: "unknown env" } }, 400);
    const paneId = c.req.param("paneId");
    if (!PANE_RE.test(paneId)) return c.json({ error: { code: "validation", message: "bad paneId" } }, 400);
    try {
      await closePane(env, paneId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: { code: "herdr", message: err instanceof Error ? err.message : String(err) } }, 500);
    }
  });

  app.get("/api/sessions/:env/:paneId/read", async (c) => {
    const env = opts.envs.find((e) => e.id === c.req.param("env"));
    if (!env) return c.json({ error: { code: "validation", message: "unknown env" } }, 400);
    const paneId = c.req.param("paneId");
    if (!PANE_RE.test(paneId)) return c.json({ error: { code: "validation", message: "bad paneId" } }, 400);
    // Guard `?lines=`: an absent key → 50; a present-but-bad value (`""`→0, `"abc"`→NaN) → 50;
    // otherwise clamp to [1, 500] so a caller can't drive `herdr pane read --lines 0|NaN|100000`.
    const rawLines = c.req.query("lines");
    const lines = rawLines !== undefined ? Math.max(1, Math.min(500, Number(rawLines) || 50)) : 50;
    // Key by the pane's CURRENT sessionId too: paneId is reuse-prone (herdr restart churn), so without
    // it a restart that reassigns this paneId to a different session could serve the prior session's
    // cached text within the TTL. A changed sessionId → different key → cache miss → fresh read.
    const liveSid = opts.poller.getSnapshot().sessions.find((s) => s.env === env.id && s.paneId === paneId)?.sessionId ?? "";
    const cacheKey = `${env.id}:${paneId}:${String(lines)}:${liveSid}`;
    const cached = readCache.get(cacheKey);
    if (cached !== undefined) return c.json(cached);
    try {
      const result = await read(env, paneId, lines);
      readCache.set(cacheKey, result); // cache successes only — a 502 must not stick
      return c.json(result);
    } catch (err) {
      // Unreachable env / herdr timeout is an expected, frequently-polled condition (the Unassigned
      // mini-terminal reads every 5s per card) — return the structured shape its siblings use rather
      // than a bare 500 + stack. The client's read loop keeps the last good snapshot on this.
      return c.json({ error: { code: "read_failed", message: err instanceof Error ? err.message : String(err) } }, 502);
    }
  });

  // Last-activity timestamp derived from the session's Claude transcript, TTL-cached per env+session
  // to keep detached-row polling cheap. Called only for detached session rows, never per SSE frame.
  app.get("/api/sessions/:env/:sessionId/last-active", async (c) => {
    const env = opts.envs.find((e) => e.id === c.req.param("env"));
    if (!env) return c.json({ error: { code: "validation", message: "unknown env" } }, 400);
    const sessionId = c.req.param("sessionId");
    if (!UUID_RE.test(sessionId)) return c.json({ error: { code: "validation", message: "bad sessionId" } }, 400);
    const key = `${env.id}:${sessionId}`;
    const cached = laCache.get(key);
    if (cached !== undefined) return c.json({ lastActive: cached }); // undefined = miss; null = cached "no transcript"
    let value: number | null;
    try {
      value = await lastActivity(env, sessionId);
    } catch {
      value = null;
    }
    laCache.set(key, value);
    return c.json({ lastActive: value });
  });

  // Targets for the spawn "Into" picker: existing herdr spaces to JOIN (live; empty on an unreachable
  // env) plus the env's configured repos to create a NEW space from (from trusted config — always
  // available even when the env is unreachable). The client groups them and dedupes a repo that already
  // has a same-named space. Env is validated against the trusted list.
  app.get("/api/envs/:env/spawn-targets", async (c) => {
    const env = opts.envs.find((e) => e.id === c.req.param("env"));
    if (!env) return c.json({ error: { code: "validation", message: "unknown env" } }, 400);
    // Only repo NAMES cross to the browser — the configured absolute paths stay server-side (used at
    // spawn to root a new space; the client just needs the name to pick and to send back as `repo`).
    const repos = Object.keys(env.repos).map((name) => ({ name }));
    let spaces: { workspaceId: string; label: string }[] = [];
    try {
      spaces = (await listWs(env)).map((w) => ({ workspaceId: w.workspace_id, label: w.label }));
    } catch { /* unreachable env → no join targets; repo options still offered */ }
    return c.json({ spaces, repos });
  });

  // Drop-to-attach upload (local envs only). Bytes land in a temp file on THIS machine; the web then
  // injects the returned absolute path into the pane. Origin-allowlisted (multipart is a CORS-simple
  // content type, so the Host-only anti-rebinding middleware above is insufficient) + a pre-buffer
  // body-limit (a post-parse size check cannot prevent the OOM). Remote envs are refused — remote needs
  // SSH byte transfer (v2). No auth beyond the loopback bind + Origin gate, matching the JSON API.
  app.post(
    "/api/envs/:env/uploads",
    bodyLimit({
      maxSize: UPLOAD_MAX_BYTES,
      onError: (c) => c.json({ error: { code: "too_large", message: "file exceeds the 25 MB limit" } }, 413),
    }),
    async (c) => {
      const origin = c.req.header("origin");
      if (origin === undefined || !allowedOrigins.includes(origin)) {
        return c.json({ error: { code: "forbidden", message: "origin not allowed" } }, 403);
      }
      const env = opts.envs.find((e) => e.id === c.req.param("env"));
      if (!env) return c.json({ error: { code: "validation", message: "unknown env" } }, 400);
      if (env.kind !== "local") {
        return c.json({ error: { code: "remote_upload_unsupported", message: "file attach is available for local environments only" } }, 400);
      }
      let body: Record<string, string | File>;
      try {
        body = await c.req.parseBody();
      } catch {
        return c.json({ error: { code: "validation", message: "invalid form body" } }, 400);
      }
      const file = body.file;
      if (!(file instanceof File)) {
        return c.json({ error: { code: "validation", message: "missing 'file' field" } }, 400);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const dest = await writeUploadFile({ root: uploadRoot, originalName: file.name, bytes });
      // Audit (SEC-6 posture): record the write, never the contents.
      console.warn(`[upload] env=${env.id} bytes=${String(bytes.byteLength)} path=${dest}`);
      return c.json({ path: dest });
    },
  );

  // ---------- boards CRUD ----------

  app.get("/api/boards", (c) => {
    if (opts.storage === undefined) return c.json({ error: { code: "no_storage" } }, 503);
    return c.json(opts.storage.getAllBoards());
  });

  app.post("/api/boards", async (c) => {
    if (opts.storage === undefined) return c.json({ error: { code: "no_storage" } }, 503);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: { code: "validation", message: "invalid JSON" } }, 400); }
    const parsed = CreateBoardBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "validation", message: parsed.error.message } }, 400);
    const { label } = parsed.data;
    const id = slugifyBoardId(label);
    const existingIds = opts.storage.listBoardIds();
    if (existingIds.includes(id)) {
      return c.json({ error: { code: "board_id_collision", generatedId: id } }, 409);
    }
    const board = await opts.storage.withBoard(id, () => {
      const b = { id, label, columns: [...DEFAULT_COLUMNS], tasks: [] };
      return { board: b, result: b };
    });
    return c.json(board, 201);
  });

  app.get("/api/boards/:bid", (c) => {
    if (opts.storage === undefined) return c.json({ error: { code: "no_storage" } }, 503);
    const bid = c.req.param("bid");
    if (!BID_RE.test(bid)) return c.json({ error: { code: "validation", message: "bad boardId" } }, 400);
    const board = opts.storage.getBoard(bid);
    if (board === null) return c.json({ error: { code: "not_found" } }, 404);
    return c.json(board);
  });

  app.patch("/api/boards/:bid", async (c) => {
    if (opts.storage === undefined) return c.json({ error: { code: "no_storage" } }, 503);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: { code: "validation", message: "invalid JSON" } }, 400); }
    const parsed = PatchBoardBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "validation", message: parsed.error.message } }, 400);
    const bid = c.req.param("bid");
    if (!BID_RE.test(bid)) return c.json({ error: { code: "validation", message: "bad boardId" } }, 400);
    const { label, columns } = parsed.data;
    if (columns?.length === 0) {
      return c.json({ error: { code: "validation", message: "columns must not be empty" } }, 400);
    }
    const result = await opts.storage.withBoard(bid, (existing) => {
      if (existing === null) return { board: null, result: null };
      let updated = { ...existing };
      if (label !== undefined) updated = { ...updated, label };
      if (columns !== undefined) {
        const removedIds = new Set(existing.columns.map((col) => col.id).filter((id) => !columns.some((c2) => c2.id === id)));
        const firstColId = columns[0]?.id;
        if (removedIds.size > 0 && firstColId !== undefined) {
          updated = {
            ...updated,
            tasks: existing.tasks.map((task) =>
              removedIds.has(task.status) ? { ...task, status: firstColId } : task,
            ),
          };
        }
        updated = { ...updated, columns };
      }
      return { board: updated, result: updated };
    });
    if (result === null) return c.json({ error: { code: "not_found" } }, 404);
    return c.json(result);
  });

  app.delete("/api/boards/:bid", async (c) => {
    if (opts.storage === undefined) return c.json({ error: { code: "no_storage" } }, 503);
    const bid = c.req.param("bid");
    if (!BID_RE.test(bid)) return c.json({ error: { code: "validation", message: "bad boardId" } }, 400);
    const existed = await opts.storage.withBoard(bid, (existing) => ({
      board: null,
      result: existing !== null,
    }));
    if (!existed) return c.json({ error: { code: "not_found" } }, 404);
    return c.json({ ok: true });
  });

  // ---------- tasks CRUD ----------

  app.post("/api/boards/:bid/tasks", async (c) => {
    if (opts.storage === undefined) return c.json({ error: { code: "no_storage" } }, 503);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: { code: "validation", message: "invalid JSON" } }, 400); }
    const parsed = CreateTaskBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "validation", message: parsed.error.message } }, 400);
    const bid = c.req.param("bid");
    if (!BID_RE.test(bid)) return c.json({ error: { code: "validation", message: "bad boardId" } }, 400);
    const now = nowSecs();
    const task = await opts.storage.withBoard(bid, (existing) => {
      if (existing === null) return { board: null, result: null };
      const newTask = {
        id: generateTaskId(),
        title: parsed.data.title,
        description: parsed.data.description ?? "",
        status: parsed.data.status,
        priority: parsed.data.priority ?? null,
        repo: parsed.data.repo ?? null,
        sessions: [],
        createdAt: now,
        updatedAt: now,
      };
      return { board: { ...existing, tasks: [...existing.tasks, newTask] }, result: newTask };
    });
    if (task === null) return c.json({ error: { code: "not_found" } }, 404);
    return c.json(task, 201);
  });

  app.patch("/api/boards/:bid/tasks/:tid", async (c) => {
    if (opts.storage === undefined) return c.json({ error: { code: "no_storage" } }, 503);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: { code: "validation", message: "invalid JSON" } }, 400); }
    const parsed = PatchTaskBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "validation", message: parsed.error.message } }, 400);
    const bid = c.req.param("bid");
    if (!BID_RE.test(bid)) return c.json({ error: { code: "validation", message: "bad boardId" } }, 400);
    const tid = c.req.param("tid");
    if (!TID_RE.test(tid)) return c.json({ error: { code: "validation", message: "bad taskId" } }, 400);
    type PatchResult = null | { found: false } | { found: true; task: Task };
    const result = await opts.storage.withBoard<PatchResult>(bid, (existing) => {
      if (existing === null) return { board: null, result: null };
      const idx = existing.tasks.findIndex((t) => t.id === tid);
      if (idx === -1) return { board: existing, result: { found: false } };
      const old = existing.tasks[idx];
      if (old === undefined) return { board: existing, result: { found: false } };
      const updated = {
        ...old,
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.repo !== undefined ? { repo: parsed.data.repo } : {}),
        updatedAt: nowSecs(),
      };
      const tasks = [...existing.tasks];
      tasks[idx] = updated;
      return { board: { ...existing, tasks }, result: { found: true, task: updated } };
    });
    if (!result?.found) return c.json({ error: { code: "not_found" } }, 404);
    return c.json(result.task);
  });

  app.delete("/api/boards/:bid/tasks/:tid", async (c) => {
    if (opts.storage === undefined) return c.json({ error: { code: "no_storage" } }, 503);
    const bid = c.req.param("bid");
    if (!BID_RE.test(bid)) return c.json({ error: { code: "validation", message: "bad boardId" } }, 400);
    const tid = c.req.param("tid");
    if (!TID_RE.test(tid)) return c.json({ error: { code: "validation", message: "bad taskId" } }, 400);
    const found = await opts.storage.withBoard(bid, (existing) => {
      if (existing === null) return { board: null, result: false };
      const idx = existing.tasks.findIndex((t) => t.id === tid);
      if (idx === -1) return { board: existing, result: false };
      const tasks = [...existing.tasks];
      tasks.splice(idx, 1);
      return { board: { ...existing, tasks }, result: true };
    });
    if (!found) return c.json({ error: { code: "not_found" } }, 404);
    return c.json({ ok: true });
  });

  // ---------- attach / detach / from-session ----------

  app.post("/api/boards/:bid/tasks/:tid/attach", async (c) => {
    if (opts.storage === undefined) return c.json({ error: { code: "no_storage" } }, 503);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: { code: "validation", message: "invalid JSON" } }, 400); }
    const parsed = AttachBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "validation", message: parsed.error.message } }, 400);
    const bid = c.req.param("bid");
    if (!BID_RE.test(bid)) return c.json({ error: { code: "validation", message: "bad boardId" } }, 400);
    const tid = c.req.param("tid");
    if (!TID_RE.test(tid)) return c.json({ error: { code: "validation", message: "bad taskId" } }, 400);
    const { env, paneId } = parsed.data;
    if (!opts.envs.find((e) => e.id === env)) {
      return c.json({ error: { code: "validation", message: "unknown env" } }, 400);
    }
    if (!PANE_RE.test(paneId)) {
      return c.json({ error: { code: "validation", message: "bad paneId" } }, 400);
    }
    const key = `${env}:${paneId}`;

    // Enrich from the live poller snapshot: the drag/drop client only sends env+paneId, so without
    // this the stored link has empty tab/workspace labels and the card renders " / ". The snapshot
    // is the source of truth for the current labels; fall back to any body-supplied values.
    const liveRow = opts.poller.getSnapshot().sessions.find((s) => `${s.env}:${s.paneId}` === key);

    const result = await opts.storage.withBoard(bid, (existing) => {
      if (existing === null) return { board: null, result: "board_not_found" as const };
      const taskIdx = existing.tasks.findIndex((t) => t.id === tid);
      if (taskIdx === -1) return { board: existing, result: "task_not_found" as const };
      const task = existing.tasks[taskIdx];
      if (task === undefined) return { board: existing, result: "task_not_found" as const };
      // Idempotent only for the SAME live session (by UUID, else paneId for legacy null-UUID links).
      // A stale dead-UUID pane-mate no longer suppresses the append, so a restarted session attaches
      // alongside the old (now-detached) card.
      if (isSessionBound(task.sessions, { env, paneId, liveSessionId: liveRow?.sessionId ?? null })) {
        return { board: existing, result: "ok" as const };
      }
      // Check if already assigned in any board (must check all boards, but we only hold this board's mutex)
      // Per spec: claim-checked only for from-session; attach is idempotent within the task
      const link: SessionLink = {
        env: parsed.data.env,
        paneId: parsed.data.paneId,
        // Persist the stable herdr ids from the live row (the client sends only {env,paneId}); without
        // them a later close/resume has no tab/workspace to address. Body values are a legacy fallback.
        tabId: liveRow?.tabId ?? parsed.data.tabId,
        tabLabel: liveRow !== undefined ? liveRow.tab : parsed.data.tabLabel,
        workspaceId: liveRow?.workspaceId ?? parsed.data.workspaceId,
        workspaceLabel: liveRow !== undefined ? liveRow.workspace : parsed.data.workspaceLabel,
        name: parsed.data.name !== ""
          ? parsed.data.name
          : (liveRow !== undefined ? (liveRow.tab !== "?" && liveRow.tab !== "" ? liveRow.tab : liveRow.paneId) : parsed.data.paneId),
        cwdSnapshot: liveRow !== undefined ? liveRow.cwd : parsed.data.cwdSnapshot,
        // Persist the stable Claude UUID from the live row (null if the pane isn't a registered agent
        // yet — the reconciler backfills it). This is what lets the binding survive paneId churn.
        sessionId: liveRow?.sessionId ?? null,
      };
      const tasks = [...existing.tasks];
      tasks[taskIdx] = { ...task, sessions: [...task.sessions, link], updatedAt: nowSecs() };
      return { board: { ...existing, tasks }, result: "ok" as const };
    });

    if (result === "board_not_found" || result === "task_not_found") {
      return c.json({ error: { code: "not_found" } }, 404);
    }
    return c.json({ ok: true });
  });

  app.post("/api/boards/:bid/tasks/:tid/detach", async (c) => {
    if (opts.storage === undefined) return c.json({ error: { code: "no_storage" } }, 503);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: { code: "validation", message: "invalid JSON" } }, 400); }
    const parsed = DetachBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "validation", message: parsed.error.message } }, 400);
    const bid = c.req.param("bid");
    if (!BID_RE.test(bid)) return c.json({ error: { code: "validation", message: "bad boardId" } }, 400);
    const tid = c.req.param("tid");
    if (!TID_RE.test(tid)) return c.json({ error: { code: "validation", message: "bad taskId" } }, 400);
    if (!opts.envs.find((e) => e.id === parsed.data.env)) {
      return c.json({ error: { code: "validation", message: "unknown env" } }, 400);
    }
    if (!PANE_RE.test(parsed.data.paneId)) {
      return c.json({ error: { code: "validation", message: "bad paneId" } }, 400);
    }
    const key = `${parsed.data.env}:${parsed.data.paneId}`;
    // Churn-heal (mirrors close): the UI may send a healed paneId for a stale-paneId link, so resolve
    // the unlink target by the live row's sessionId when the incoming paneId matches no stored link.
    const liveRow = opts.poller.getSnapshot().sessions.find((s) => `${s.env}:${s.paneId}` === key);

    const result = await opts.storage.withBoard(bid, (existing) => {
      if (existing === null) return { board: null, result: "board_not_found" as const };
      const taskIdx = existing.tasks.findIndex((t) => t.id === tid);
      if (taskIdx === -1) return { board: existing, result: "task_not_found" as const };
      const task = existing.tasks[taskIdx];
      if (task === undefined) return { board: existing, result: "task_not_found" as const };
      const idx = resolveLinkIndex(task.sessions, {
        env: parsed.data.env, paneId: parsed.data.paneId,
        sessionId: parsed.data.sessionId, liveSessionId: liveRow?.sessionId ?? null,
      });
      const sessions = idx === -1 ? task.sessions : task.sessions.filter((_, i) => i !== idx);
      const tasks = [...existing.tasks];
      tasks[taskIdx] = { ...task, sessions, updatedAt: nowSecs() };
      return { board: { ...existing, tasks }, result: "ok" as const };
    });

    if (result === "board_not_found" || result === "task_not_found") {
      return c.json({ error: { code: "not_found" } }, 404);
    }
    return c.json({ ok: true });
  });

  // Task-scoped "close" kills a running Claude session's herdr tab (herdr tab close <tabId>), which
  // terminates the session but keeps the task→session LINK — distinct from /detach above, which only
  // unlinks. This route does NOT mutate the board; the session disappears from the next poll and the
  // card renders detached.
  app.post("/api/boards/:bid/tasks/:tid/sessions/:env/:paneId/close", async (c) => {
    if (opts.storage === undefined) return c.json({ error: { code: "no_storage" } }, 503);
    const bid = c.req.param("bid");
    if (!BID_RE.test(bid)) return c.json({ error: { code: "validation", message: "bad boardId" } }, 400);
    const tid = c.req.param("tid");
    if (!TID_RE.test(tid)) return c.json({ error: { code: "validation", message: "bad taskId" } }, 400);
    const env = opts.envs.find((e) => e.id === c.req.param("env"));
    if (!env) return c.json({ error: { code: "validation", message: "unknown env" } }, 400);
    const paneId = c.req.param("paneId");
    if (!PANE_RE.test(paneId)) return c.json({ error: { code: "validation", message: "bad paneId" } }, 400);
    const board = opts.storage.getBoard(bid);
    if (board === null) return c.json({ error: { code: "not_found" } }, 404);
    const task = board.tasks.find((t) => t.id === tid);
    if (task === undefined) return c.json({ error: { code: "not_found" } }, 404);
    // ?sid picks one of possibly-several same-pane links; absent → paneId resolution + churn-heal.
    const sid = c.req.query("sid") ?? null;
    if (sid !== null && !UUID_RE.test(sid)) return c.json({ error: { code: "validation", message: "bad sid" } }, 400);
    const key = `${env.id}:${paneId}`;
    const liveRow = opts.poller.getSnapshot().sessions.find((s) => `${s.env}:${s.paneId}` === key);
    const idx = resolveLinkIndex(task.sessions, { env: env.id, paneId, sessionId: sid, liveSessionId: liveRow?.sessionId ?? null });
    const link = idx === -1 ? undefined : task.sessions[idx];
    if (link === undefined) return c.json({ error: { code: "not_found", message: "session not linked" } }, 404);
    // Prefer the live row's CURRENT tabId — but only when its sessionId confirms it's the same session
    // (never trust a reused pane). This also heals a legacy link persisted with an empty tabId.
    const linkSid = link.sessionId;
    let tabId = link.tabId;
    if (liveRow !== undefined && linkSid !== null && linkSid !== "" && liveRow.sessionId === linkSid && liveRow.tabId !== undefined && liveRow.tabId !== "") {
      tabId = liveRow.tabId;
    }
    if (tabId === "") {
      return c.json({ error: { code: "no_tab", message: "no herdr tab recorded for this session — re-attach it, then close" } }, 400);
    }
    try {
      await closeTab(env, tabId);
    } catch (err) {
      return c.json({ error: { code: "close_failed", message: err instanceof Error ? err.message : String(err) } }, 502);
    }
    return c.json({ ok: true });
  });

  // Resume restarts a stopped Claude session: `claude --resume <uuid>` continues the SAME session id,
  // so the rebound link KEEPS `link.sessionId` — only pane/tab/workspace coordinates change.
  app.post("/api/boards/:bid/tasks/:tid/sessions/:env/:paneId/resume", async (c) => {
    if (opts.storage === undefined || opts.spawn === undefined) return c.json({ error: { code: "not_configured" } }, 503);
    const bid = c.req.param("bid");
    if (!BID_RE.test(bid)) return c.json({ error: { code: "validation", message: "bad boardId" } }, 400);
    const tid = c.req.param("tid");
    if (!TID_RE.test(tid)) return c.json({ error: { code: "validation", message: "bad taskId" } }, 400);
    const env = opts.envs.find((e) => e.id === c.req.param("env"));
    if (!env) return c.json({ error: { code: "validation", message: "unknown env" } }, 400);
    const paneId = c.req.param("paneId");
    if (!PANE_RE.test(paneId)) return c.json({ error: { code: "validation", message: "bad paneId" } }, 400);
    const board = opts.storage.getBoard(bid);
    if (board === null) return c.json({ error: { code: "not_found" } }, 404);
    const task = board.tasks.find((t) => t.id === tid);
    if (task === undefined) return c.json({ error: { code: "not_found" } }, 404);
    // ?sid picks one of possibly-several same-pane links; absent → paneId resolution + churn-heal.
    const sid = c.req.query("sid") ?? null;
    if (sid !== null && !UUID_RE.test(sid)) return c.json({ error: { code: "validation", message: "bad sid" } }, 400);
    const key = `${env.id}:${paneId}`;
    const liveRow = opts.poller.getSnapshot().sessions.find((s) => `${s.env}:${s.paneId}` === key);
    const idx = resolveLinkIndex(task.sessions, { env: env.id, paneId, sessionId: sid, liveSessionId: liveRow?.sessionId ?? null });
    const link = idx === -1 ? undefined : task.sessions[idx];
    if (link === undefined) return c.json({ error: { code: "not_found", message: "session not linked" } }, 404);
    if (link.sessionId === null || link.sessionId === "") {
      return c.json({ error: { code: "no_session_id", message: "no Claude session id to resume" } }, 400);
    }
    if (!UUID_RE.test(link.sessionId)) {
      return c.json({ error: { code: "validation", message: "bad sessionId" } }, 400);
    }
    const repoPath = task.repo !== null && Object.hasOwn(env.repos, task.repo) ? (env.repos[task.repo] ?? null) : null;
    let result: SpawnResult;
    try {
      result = await opts.spawn({
        env, taskSlug: sanitizeSlug(task.title), cwd: link.cwdSnapshot, repo: task.repo,
        assignedPaneIds: new Set(),
        spawnCommand: env.spawnCommand,
        targetWorkspaceId: link.workspaceId, repoPath,
        resumeSessionId: link.sessionId,
      });
    } catch (err) {
      return c.json({ error: { code: "resume_failed", message: err instanceof Error ? err.message : String(err) } }, 502);
    }
    const rebuilt: SessionLink = {
      ...link,
      paneId: result.paneId, tabId: result.tabId, workspaceId: result.workspaceId,
      tabLabel: result.tabLabel, workspaceLabel: result.workspaceLabel, cwdSnapshot: result.cwdSnapshot,
      // sessionId kept — `claude --resume` continues the same uuid (Task 1 probe). If the probe found
      // it mints a new uuid, set `sessionId: null` here instead so the reconciler backfills by paneId.
    };
    await opts.storage.withBoard(bid, (b) => {
      if (b === null) return { board: null, result: undefined };
      return {
        board: {
          ...b,
          // Rebind ONLY the resolved link, matched by env + its stable sessionId — NOT by `${env}:${paneId}`,
          // which with two same-pane links would clobber the live sibling. Env-scoped like every other
          // resolver here (resolveLinkIndex/isSessionBound): a Claude sessionId is unique per env, not
          // globally, so a same-uuid link in another env of this task must not be overwritten. resume
          // requires a non-null sessionId (checked above), so this targets exactly the resumed link.
          tasks: b.tasks.map((t) => t.id === tid
            ? { ...t, sessions: t.sessions.map((s) => s.env === link.env && s.sessionId === link.sessionId ? rebuilt : s), updatedAt: nowSecs() }
            : t),
        },
        result: undefined,
      };
    });
    return c.json(rebuilt);
  });

  app.post("/api/boards/:bid/tasks/:tid/spawn", async (c) => {
    if (opts.storage === undefined || opts.spawn === undefined) {
      return c.json({ error: { code: "not_configured" } }, 503);
    }
    const bid = c.req.param("bid");
    if (!BID_RE.test(bid)) return c.json({ error: { code: "validation", message: "bad boardId" } }, 400);
    const tid = c.req.param("tid");
    if (!TID_RE.test(tid)) return c.json({ error: { code: "validation", message: "bad taskId" } }, 400);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: { code: "validation", message: "invalid JSON" } }, 400); }
    const parsed = z.object({
      env: z.string(),
      targetWorkspaceId: z.string().nullable().optional(),
      repo: z.string().nullable().optional(), // repo to root a NEW space at (config key); ignored when joining
    }).safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "validation", message: "env required" } }, 400);

    const targetEnv = opts.envs.find((e) => e.id === parsed.data.env);
    if (targetEnv === undefined) return c.json({ error: { code: "validation", message: "unknown env" } }, 400);

    // targetWorkspaceId is the only new client value that reaches herdr (`--workspace <id>`); guard it.
    const rawTwid = parsed.data.targetWorkspaceId;
    if (rawTwid !== null && rawTwid !== undefined && !WS_RE.test(rawTwid)) {
      return c.json({ error: { code: "validation", message: "bad targetWorkspaceId" } }, 400);
    }

    const board = opts.storage.getBoard(bid);
    if (board === null) return c.json({ error: { code: "not_found" } }, 404);
    const task = board.tasks.find((t) => t.id === tid);
    if (task === undefined) return c.json({ error: { code: "not_found" } }, 404);

    const allBoards = opts.storage.getAllBoards();
    const assignedPaneIds = new Set<string>();
    for (const b of allBoards) {
      for (const t of b.tasks) {
        for (const s of t.sessions) assignedPaneIds.add(s.paneId);
      }
    }

    // Grouping: resolve the repo's configured path (for creating a new space) and the chosen target
    // space (null = create new). spawnCommand comes from the trusted env config, never the client.
    // `Object.hasOwn` so a repo named "__proto__"/"constructor" can't resolve an inherited value
    // (a plain-object index would return Object.prototype, not undefined) and reach herdr as a non-string.
    const targetWorkspaceId = parsed.data.targetWorkspaceId ?? null;
    // The repo whose configured path roots a NEW space (ignored when joining an existing one): the
    // spawn request's explicit pick, else the task's stored repo. Used only to look up a trusted config
    // path — never sent to herdr as-is; `Object.hasOwn` blocks inherited/prototype keys.
    const newSpaceRepo = parsed.data.repo ?? task.repo;
    const repoPath = newSpaceRepo !== null && Object.hasOwn(targetEnv.repos, newSpaceRepo)
      ? (targetEnv.repos[newSpaceRepo] ?? null)
      : null;

    const slug = sanitizeSlug(task.title);
    // Pick the next free a–z suffix for this task's Nth spawned session — each is a distinct herdr tab
    // `${slug}-<suffix>`. Only spawn-named links occupy these (attached sessions carry their own
    // tab-label names), so a task can hold up to 26 spawned sessions plus any number of attached ones.
    const usedNames = new Set(task.sessions.map((s) => s.name));
    const sessionSuffix = SPAWN_SUFFIXES.find((sfx) => !usedNames.has(`${slug}-${sfx}`));
    if (sessionSuffix === undefined) {
      return c.json({ error: { code: "session_cap", message: "task already has 26 spawned sessions (a–z) — attach or remove one first" } }, 409);
    }
    const spawnTimerHandle = { id: setTimeout(() => { /* replaced below */ }, 0) };
    clearTimeout(spawnTimerHandle.id);
    const spawnTimeoutPromise = new Promise<never>((_, rej) => {
      spawnTimerHandle.id = setTimeout(() => { rej(new Error("spawn_timeout")); }, spawnTimeoutMs);
    });
    // Keep a handle to the spawn so a timeout can tear down whatever it eventually creates (below).
    const spawnPromise = opts.spawn({
      env: targetEnv, taskSlug: slug, sessionSuffix,
      cwd: task.sessions[0]?.cwdSnapshot ?? process.cwd(),
      repo: newSpaceRepo, assignedPaneIds,
      spawnCommand: targetEnv.spawnCommand,
      targetWorkspaceId, repoPath,
    });
    try {
      const result = await Promise.race([spawnPromise, spawnTimeoutPromise]);
      const link: SessionLink = {
        env: targetEnv.id, paneId: result.paneId,
        tabId: result.tabId, tabLabel: result.tabLabel,
        workspaceId: result.workspaceId, workspaceLabel: result.workspaceLabel,
        name: `${slug}-${sessionSuffix}`, cwdSnapshot: result.cwdSnapshot,
        // Almost always null here — Claude hasn't registered on the fresh pane yet (it's absent from
        // `agent list` until then). Not a bug: the reconciler backfills it once the poller sees the id.
        sessionId: opts.poller.getSnapshot().sessions.find((s) => s.env === targetEnv.id && s.paneId === result.paneId)?.sessionId ?? null,
      };
      await opts.storage.withBoard(bid, (b) => {
        if (b === null) return { board: null, result: undefined };
        const t = b.tasks.find((x) => x.id === tid);
        if (t === undefined) return { board: b, result: undefined };
        return { board: { ...b, tasks: b.tasks.map((x) => x.id === tid ? { ...x, sessions: [...x.sessions, link], updatedAt: nowSecs() } : x) }, result: undefined };
      });
      return c.json({ ...link, idempotent: result.idempotent });
    } catch (err) {
      const timedOut = err instanceof Error && err.message === "spawn_timeout";
      if (timedOut) {
        // The abandoned spawn keeps running (it has no cancellation). When it finishes, tear down the
        // orphaned session it created, else it surfaces unlinked in Unassigned. Skip an idempotent
        // rejoin: it returns a PRE-EXISTING session's tab that this spawn did NOT create — closing it
        // would kill a session the user never spawned.
        void spawnPromise.then((r) => {
          if (r.idempotent) return;
          return closeTab(targetEnv, r.tabId);
        }).catch(() => void 0);
      }
      const code = timedOut ? "spawn_timeout" : "spawn_error";
      return c.json({ error: { code, message: err instanceof Error ? err.message : String(err), step: "spawn" } }, 500);
    } finally {
      clearTimeout(spawnTimerHandle.id);
    }
  });

  app.post("/api/boards/:bid/tasks/:tid/move", async (c) => {
    if (opts.storage === undefined) return c.json({ error: { code: "no_storage" } }, 503);
    const storage = opts.storage;
    const bid = c.req.param("bid");
    if (!BID_RE.test(bid)) return c.json({ error: { code: "validation", message: "bad boardId" } }, 400);
    const tid = c.req.param("tid");
    if (!TID_RE.test(tid)) return c.json({ error: { code: "validation", message: "bad taskId" } }, 400);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: { code: "validation", message: "invalid JSON" } }, 400); }
    const parsed = MoveTaskRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "validation", message: parsed.error.message } }, 400);
    const toBoardId = parsed.data.toBoardId;
    if (!BID_RE.test(toBoardId)) return c.json({ error: { code: "validation", message: "bad toBoardId" } }, 400);
    if (toBoardId === bid) return c.json({ ok: true }); // no-op

    // Lock BOTH boards together (canonical order → no deadlock): read the task FRESH from source under
    // the combined lock (kills the lost-write where a concurrent spawn/attach on the source task was
    // discarded), then add-to-target + remove-from-source both under the lock (kills the interleaving
    // where the task briefly existed on both). `withBoards` writes boardA (the target, passed first)
    // before boardB (the source) — both synchronous, so the only residual is a process crash between the
    // two writes, which then yields a recoverable duplicate rather than a lost task.
    type MoveOutcome = "ok" | "src_gone" | "task_gone" | "target_gone" | "conflict";
    const outcome = await storage.withBoards<MoveOutcome>(toBoardId, bid, (target, source) => {
      if (source === null) return { boardA: target, boardB: source, result: "src_gone" };
      if (target === null) return { boardA: target, boardB: source, result: "target_gone" };
      const task = source.tasks.find((t) => t.id === tid);
      if (task === undefined) return { boardA: target, boardB: source, result: "task_gone" };
      if (target.tasks.some((t) => t.id === tid)) return { boardA: target, boardB: source, result: "conflict" };
      // Map status: keep it if the target has that column, else fall to the target's first column.
      const status = target.columns.some((col) => col.id === task.status)
        ? task.status
        : (target.columns[0]?.id ?? task.status);
      const movedTask: Task = { ...task, status, updatedAt: nowSecs() };
      return {
        boardA: { ...target, tasks: [...target.tasks, movedTask] },
        boardB: { ...source, tasks: source.tasks.filter((t) => t.id !== tid) },
        result: "ok",
      };
    });
    if (outcome === "src_gone" || outcome === "task_gone" || outcome === "target_gone") {
      return c.json({ error: { code: "not_found" } }, 404);
    }
    if (outcome === "conflict") {
      return c.json({ error: { code: "conflict", message: "task id already exists on target" } }, 409);
    }
    return c.json({ ok: true });
  });

  app.post("/api/boards/:bid/tasks/from-session", async (c) => {
    if (opts.storage === undefined) return c.json({ error: { code: "no_storage" } }, 503);
    const storage = opts.storage;
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: { code: "validation", message: "invalid JSON" } }, 400); }
    const parsed = FromSessionBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "validation", message: parsed.error.message } }, 400);
    const bid = c.req.param("bid");
    if (!BID_RE.test(bid)) return c.json({ error: { code: "validation", message: "bad boardId" } }, 400);
    const { env, paneId } = parsed.data;
    if (!opts.envs.find((e) => e.id === env)) {
      return c.json({ error: { code: "validation", message: "unknown env" } }, 400);
    }
    if (!PANE_RE.test(paneId)) {
      return c.json({ error: { code: "validation", message: "bad paneId" } }, 400);
    }
    const key = `${env}:${paneId}`;
    const now = nowSecs();
    // Capture the stable Claude UUID from the live snapshot at write time (from-session binds a session
    // that IS live), so the new binding is churn-resolvable from the start; null if not yet registered.
    const liveRow = opts.poller.getSnapshot().sessions.find((s) => `${s.env}:${s.paneId}` === key);

    type FromSessionResult = "board_not_found" | "conflict" | { ok: true; task: Task };
    const result = await storage.withBoard<FromSessionResult>(bid, (existing) => {
      if (existing === null) return { board: null, result: "board_not_found" };
      // Claim-check: is THIS live session already bound anywhere? Uses the exact per-link complement
      // of buildUnassigned (server/session-binding.ts) so a stale dead-UUID link on the same pane no longer
      // false-conflicts a restarted session — the whole point of this fix.
      const liveSessionId = liveRow?.sessionId ?? null;
      const allLinks = storage.getAllBoards().flatMap((b) => b.tasks.flatMap((t) => t.sessions));
      if (isSessionBound(allLinks, { env, paneId, liveSessionId })) {
        return { board: existing, result: "conflict" as const };
      }
      const link: SessionLink = {
        env: parsed.data.env,
        paneId: parsed.data.paneId,
        // Prefer the live row's stable ids/cwd (from-session binds a LIVE session) so close/resume have
        // real coordinates; the client's body values are a legacy fallback for a snapshot miss.
        tabId: liveRow?.tabId ?? parsed.data.tabId,
        tabLabel: parsed.data.tabLabel,
        workspaceId: liveRow?.workspaceId ?? parsed.data.workspaceId,
        workspaceLabel: parsed.data.workspaceLabel,
        // Never store an empty name — a detached card renders "⚠ {name}", which would be a bare "⚠ ".
        name: parsed.data.name !== "" ? parsed.data.name : parsed.data.paneId,
        cwdSnapshot: liveRow !== undefined ? liveRow.cwd : parsed.data.cwdSnapshot,
        sessionId: liveRow?.sessionId ?? null,
      };
      const newTask = {
        id: generateTaskId(),
        title: parsed.data.title,
        description: parsed.data.description ?? "",
        status: parsed.data.status,
        priority: parsed.data.priority ?? null,
        repo: parsed.data.repo ?? null,
        sessions: [link],
        createdAt: now,
        updatedAt: now,
      };
      return { board: { ...existing, tasks: [...existing.tasks, newTask] }, result: { ok: true as const, task: newTask } };
    });

    if (result === "board_not_found") return c.json({ error: { code: "not_found" } }, 404);
    if (result === "conflict") return c.json({ error: { code: "conflict", message: "session already assigned" } }, 409);
    return c.json(result.task, 201);
  });

  return app;
}
