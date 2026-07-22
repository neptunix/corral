import { StreamFrameSchema, type Board, type BoardState } from "@shared/board-schema";
import type { SessionRow, StatuslineData } from "@shared/schema";
import { useState, useEffect, useCallback, useMemo, type JSX } from "react";

import { AttentionFeed } from "./components/AttentionFeed";
import { Board as BoardView } from "./components/Board";
import { BoardSettingsModal } from "./components/BoardSettingsModal";
import { BoardSwitcher } from "./components/BoardSwitcher";
import { CreateTaskModal } from "./components/CreateTaskModal";
import { SessionModal } from "./components/SessionModal";
import { UnassignedView } from "./components/UnassignedView";
import { UsageFooter } from "./components/UsageFooter";
import { api } from "./lib/api";
import { attentionCountsByBoard, unassignedAttentionCount } from "./lib/attention";
import { envLabel } from "./lib/env";
import { applyOptimisticState, type OptimisticState } from "./lib/optimistic";
import { useEventSource } from "./useEventSource";

export function App(): JSX.Element {
  const [boards, setBoards] = useState<Board[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [showUnassigned, setShowUnassigned] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [localBoardState, setLocalBoardState] = useState<BoardState | null>(null);
  // Optimistic overlay for in-flight close/resume: a row flips state instantly, then the next
  // SSE frame reconciles and clears it (same lifecycle as localBoardState). Keyed by session id (falls
  // back to env:paneId) via overrideKey, so a resume that rebinds the paneId keeps its override.
  const [optimistic, setOptimistic] = useState<Map<string, OptimisticState>>(new Map());
  const [session, setSession] = useState<{ env: string; paneId: string; awaitAgent: boolean; title: string } | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  // Board-list load status: distinguishes not-yet-loaded / error / loaded so a failed or empty load
  // doesn't sit on a permanent misleading "Loading…".
  const [boardsLoaded, setBoardsLoaded] = useState(false);
  const [boardsError, setBoardsError] = useState<string | null>(null);

  // awaitAgent = opened right after spawn: the live terminal retries until Claude registers (the pane
  // isn't an attachable agent for the first few seconds). Manual opens pass false → attach once.
  // title = the bound task's name for the modal header; "" for unassigned opens (paneId shown instead).
  const openSession = useCallback((env: string, paneId: string, awaitAgent = false, title = ""): void => {
    setSession({ env, paneId, awaitAgent, title });
  }, []);

  const closeSession = useCallback((): void => {
    setSession(null);
  }, []);

  // Load the board list (mount + Retry). Sets an error state on failure and marks loaded either way.
  const loadBoards = useCallback((): void => {
    setBoardsError(null);
    api.boards.list().then((bs) => {
      setBoards(bs);
      if (activeBoardId === null && bs.length > 0) setActiveBoardId(bs[0]?.id ?? null);
    }).catch((err: unknown) => {
      setBoardsError(err instanceof Error ? err.message : String(err));
    }).finally(() => { setBoardsLoaded(true); });
  }, [activeBoardId]);
  useEffect(() => { loadBoards(); }, [loadBoards]);

  const streamUrl = activeBoardId !== null && !showUnassigned
    ? `/api/stream?board=${activeBoardId}`
    : "/api/stream";

  // The no-board stream sends GlobalState frames (no board/tasks) — parse the union, never drop them:
  // a dropped frame freezes the attention feed and unassigned list on that view.
  const frame = useEventSource(streamUrl, StreamFrameSchema);

  // Clear the local override + optimistic overlay whenever SSE delivers a fresh snapshot. The optimistic
  // clear uses a functional guard so a zero-override poll (the steady state) doesn't force a re-render.
  useEffect(() => {
    setLocalBoardState(null);
    setOptimistic((m) => (m.size === 0 ? m : new Map()));
  }, [frame]);

  const fetchBoardState = useCallback((bid: string): void => {
    void api.state(bid).then(setLocalBoardState).catch(console.error);
  }, []);

  function refreshBoards(): void {
    api.boards.list().then(setBoards).catch(console.error);
    if (activeBoardId !== null) fetchBoardState(activeBoardId);
  }

  const markOptimistic = useCallback((key: string, state: OptimisticState): void => {
    setOptimistic((m) => { const next = new Map(m); next.set(key, state); return next; });
  }, []);
  const clearOptimistic = useCallback((key: string): void => {
    setOptimistic((m) => { if (!m.has(key)) return m; const next = new Map(m); next.delete(key); return next; });
  }, []);

  const activeBoardState = localBoardState ?? (frame !== null && "board" in frame ? frame : null);
  // Overlay optimistic close/resume intent before handing the board to the view (pure; see lib/optimistic).
  const boardStateForView = useMemo(
    () => (activeBoardState !== null && optimistic.size > 0
      ? { ...activeBoardState, tasks: applyOptimisticState(activeBoardState.tasks, optimistic) }
      : activeBoardState),
    [activeBoardState, optimistic],
  );
  // Attention + unassigned ride BOTH frame shapes; read them from whichever state is freshest.
  const globalState = localBoardState ?? frame;
  // Memoized so the derived-attention useMemos below get a stable dependency (the `?? {}` fallback
  // would otherwise mint a new object every render).
  const attention = useMemo(() => globalState?.attention ?? {}, [globalState]);
  const attentionCount = Object.keys(attention).length;
  const accounts = useMemo(() => (globalState !== null && "accounts" in globalState ? globalState.accounts : []), [globalState]);
  // Recap/statusline lookup for the live-terminal header's second line, keyed by `env:paneId` — covers
  // both unassigned rows and every task's enriched session link (`live` is null for a detached link).
  const liveByKey = useMemo(() => {
    const m = new Map<string, { recap: string | null; statusline: StatuslineData | null; workspace: string }>();
    // workspace (≈ repo) shown in the terminal header; "?" is herdr's unknown-label sentinel → drop it.
    const clean = (w: string): string => (w === "?" ? "" : w);
    for (const s of globalState?.unassigned ?? []) m.set(`${s.env}:${s.paneId}`, { recap: s.recap, statusline: s.statusline, workspace: clean(s.workspace) });
    if (activeBoardState !== null) {
      for (const t of activeBoardState.tasks) for (const link of t.sessions) {
        if (link.live !== null) m.set(`${link.env}:${link.paneId}`, { recap: link.live.recap, statusline: link.live.statusline, workspace: clean(link.workspaceLabel) });
      }
    }
    return m;
  }, [globalState, activeBoardState]);
  // Per-board attribution is pure client logic from boards + attention (design 2026-07-10): the
  // switcher badges and the per-board feed derive from one index, so they can't disagree.
  const attentionCounts = useMemo(() => attentionCountsByBoard(attention, boards), [attention, boards]);
  const unassignedAttnCount = useMemo(() => unassignedAttentionCount(attention, boards), [attention, boards]);

  // Tab title carries the GLOBAL count (all boards + unassigned) so a blocked/finished session is
  // visible from any board even when the app isn't focused — the one intentionally-global signal.
  useEffect(() => {
    document.title = attentionCount > 0 ? `(${String(attentionCount)}) corral` : "corral";
  }, [attentionCount]);

  async function handleNewBoard(): Promise<void> {
    const label = window.prompt("Board name:");
    if (!label?.trim()) return;
    const b = await api.boards.create(label.trim());
    setBoards((prev) => [...prev, b]);
    setActiveBoardId(b.id);
    setShowUnassigned(false);
  }

  async function handleCreateTask(boardId: string, title: string, session: SessionRow, sessionName: string | null): Promise<void> {
    try {
      await api.tasks.fromSession(boardId, {
        title,
        env: session.env,
        paneId: session.paneId,
        // `name` renders on a DETACHED card ("⚠ {name}") after pane churn, where read-time label
        // backfill has no live row — without it the card shows a bare paneId. Labels are stored too
        // so they survive the session's death (alive sessions are backfilled at read time anyway).
        name: sessionName ?? "",
        tabLabel: session.tab !== "?" ? session.tab : "",
        workspaceLabel: session.workspace !== "?" ? session.workspace : "",
      });
    } catch (err) {
      // Surfaces the from-session claim race (409 "session already assigned") and validation
      // failures — previously swallowed as an unhandled rejection (review finding #1).
      window.alert(`Create task failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setActiveBoardId(boardId);
    fetchBoardState(boardId); // instant confirmation even when already viewing the target board
    // Refresh the boards list too: per-board attention attribution reads bindings from `boards`, so a
    // newly-bound session would otherwise stay mis-attributed (as unassigned) until the next refresh.
    api.boards.list().then(setBoards).catch(console.error);
    setShowUnassigned(false);
  }

  // Bind an existing unassigned session to an existing task (the Unassigned card's "Assign to task").
  // attach appends the link (a card holds 0..n sessions) and the server persists the session's stable
  // sessionId, so the binding survives paneId churn. Same post-write refresh as create/from-session.
  async function handleAssignTask(boardId: string, taskId: string, session: SessionRow): Promise<void> {
    try {
      await api.tasks.attach(boardId, taskId, session.env, session.paneId);
    } catch (err) {
      window.alert(`Assign failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setActiveBoardId(boardId);
    fetchBoardState(boardId);
    api.boards.list().then(setBoards).catch(console.error);
    setShowUnassigned(false);
  }

  // Plain task create (the header "+ New task" button). Modal-driven, not window.prompt: a prior
  // dialog with "prevent additional dialogs" checked silently suppresses window.prompt (no error),
  // which made the button appear dead. status = the target board's first column.
  async function handleNewTask(boardId: string, title: string): Promise<void> {
    const status = boards.find((b) => b.id === boardId)?.columns[0]?.id ?? "todo";
    try {
      await api.tasks.create(boardId, { title, status });
    } catch (err) {
      window.alert(`Create task failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setNewTaskOpen(false);
    setActiveBoardId(boardId);
    fetchBoardState(boardId);
    api.boards.list().then(setBoards).catch(console.error);
  }

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <BoardSwitcher
        boards={boards}
        activeBoardId={activeBoardId}
        unassignedCount={globalState?.unassigned.length ?? 0}
        attentionCounts={attentionCounts}
        unassignedAttentionCount={unassignedAttnCount}
        showingUnassigned={showUnassigned}
        onSelect={(id) => { setActiveBoardId(id); setShowUnassigned(false); }}
        onUnassigned={() => { setShowUnassigned(true); }}
        onNewBoard={() => { void handleNewBoard(); }}
      />

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden min-w-0 bg-grid">
          {showUnassigned ? (
            <UnassignedView
              sessions={globalState?.unassigned ?? []}
              boards={boards}
              envs={globalState?.envs ?? {}}
              onOpen={openSession}
              onCreateTask={(bid, title, session, name) => { void handleCreateTask(bid, title, session, name); }}
              onAssignTask={(bid, tid, session) => { void handleAssignTask(bid, tid, session); }}
            />
          ) : boardStateForView !== null ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex items-center px-4 pt-3 pb-1 gap-2">
                <h1 className="text-foreground font-semibold">{boardStateForView.board.label}</h1>
                <button
                  onClick={() => { setShowSettings(true); }}
                  className="text-muted-foreground hover:text-foreground text-sm ml-1"
                  title="Board settings"
                >⚙</button>
                <button
                  onClick={() => { setNewTaskOpen(true); }}
                  className="ml-auto px-3 py-1 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90"
                >+ New task</button>
              </div>
              <BoardView
                boardState={boardStateForView}
                boards={boards}
                onBoardStateChange={refreshBoards}
                onOpenSession={openSession}
                onMarkOptimistic={markOptimistic}
                onClearOptimistic={clearOptimistic}
              />
            </div>
          ) : boardsError !== null ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <div className="text-red-500 text-sm">Failed to load boards: {boardsError}</div>
              <button
                onClick={() => { loadBoards(); }}
                className="px-3 py-1 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90"
              >Retry</button>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              {boardsLoaded ? "Select a board" : "Loading…"}
            </div>
          )}
        </div>

        {/* The rail is per-board, so it accompanies a board view only — hidden on the global
            Unassigned view (matches the design's State B) and before any board is selected. */}
        {!showUnassigned && activeBoardId !== null && (
          <AttentionFeed
            attention={attention}
            boards={boards}
            envs={globalState?.envs ?? {}}
            activeBoardId={activeBoardId}
            onOpen={openSession}
          />
        )}
      </div>

      {showSettings && activeBoardId !== null && activeBoardState !== null && (
        <BoardSettingsModal
          board={activeBoardState.board}
          onSave={(patch) => {
            void api.boards.update(activeBoardId, patch).then(() => { refreshBoards(); });
          }}
          onClose={() => { setShowSettings(false); }}
        />
      )}

      {session !== null && (
        <SessionModal
          key={`${session.env}:${session.paneId}`}
          env={session.env}
          envLabel={envLabel(globalState?.envs ?? {}, session.env)}
          paneId={session.paneId}
          awaitAgent={session.awaitAgent}
          title={session.title}
          workspace={liveByKey.get(`${session.env}:${session.paneId}`)?.workspace ?? ""}
          recap={liveByKey.get(`${session.env}:${session.paneId}`)?.recap ?? null}
          statusline={liveByKey.get(`${session.env}:${session.paneId}`)?.statusline ?? null}
          canAttachFiles={globalState?.envs[session.env]?.kind === "local"}
          onClose={closeSession}
        />
      )}

      {newTaskOpen && activeBoardId !== null && (
        <CreateTaskModal
          boards={boards}
          defaultTitle=""
          heading="New task"
          defaultBoardId={activeBoardId}
          onConfirm={(bid, title) => { void handleNewTask(bid, title); }}
          onClose={() => { setNewTaskOpen(false); }}
        />
      )}

      <UsageFooter accounts={accounts} />
    </div>
  );
}
