import { StreamFrameSchema, type BoardFrame, type BoardState, type SpawnPreset } from "@shared/board-schema";
import type { RecapSource, RecapStatus, RegistryStatus, SessionRow, StatuslineData } from "@shared/schema";
import { useState, useEffect, useCallback, useMemo, type JSX } from "react";

import { Board as BoardView } from "./components/Board";
import { BoardSettingsModal } from "./components/BoardSettingsModal";
import { BoardSwitcher } from "./components/BoardSwitcher";
import { CreateTaskModal } from "./components/CreateTaskModal";
import { SessionModal } from "./components/SessionModal";
import { SideRail } from "./components/SideRail";
import { UnassignedView } from "./components/UnassignedView";
import { UsageFooter } from "./components/UsageFooter";
import { api } from "./lib/api";
import { attentionCountsByBoard, unassignedAttentionCount } from "./lib/attention";
import { pickBoardState, pickGlobalState } from "./lib/board-precedence";
import { envLabel } from "./lib/env";
import { applyOptimisticState, type OptimisticState } from "./lib/optimistic";
import { useEventSource } from "./useEventSource";

export function App(): JSX.Element {
  const [boards, setBoards] = useState<BoardFrame[]>([]);
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
  // The Health panel's "Fix issues" click, waiting for BoardView to create the ad-hoc task and consume
  // it. Lives here, not in SideRail or BoardView, because it crosses from one sibling to the other.
  const [fixIssuesRequest, setFixIssuesRequest] =
    useState<{ title: string; description: string; preset: SpawnPreset } | null>(null);
  // Board-list load status: distinguishes not-yet-loaded / error / loaded so a failed or empty load
  // doesn't sit on a permanent misleading "Loading…".
  const [boardsLoaded, setBoardsLoaded] = useState(false);
  const [boardsError, setBoardsError] = useState<string | null>(null);
  // Cold-start floor for the board. Everything else on the board rides SSE, which means on mount the
  // FIRST frame is the only thing that can fill it — and a first frame that is lost, withheld by a
  // buffering reverse proxy, or dropped by useEventSource's schema guard leaves a blank board until
  // the next poller tick, i.e. up to a full poll interval with nothing on screen explaining why.
  // Both failure modes are real: a proxy held the frame tail in production, and the no-board stream
  // once emitted a shape the client's schema rejected outright. So seed the board once from the REST
  // snapshot, which `GET /api/state?board=` builds with the very same builder as a board frame.
  const [seedState, setSeedState] = useState<BoardState | null>(null);

  // awaitAgent = opened right after spawn: the live terminal retries until Claude registers (the pane
  // isn't an attachable agent for the first few seconds). Manual opens pass false → attach once.
  // title = the bound task's name for the modal header; "" for unassigned opens (paneId shown instead).
  const openSession = useCallback((env: string, paneId: string, awaitAgent = false, title = ""): void => {
    setSession({ env, paneId, awaitAgent, title });
  }, []);

  const closeSession = useCallback((): void => {
    setSession(null);
  }, []);

  // Same stability requirement as refreshBoards above — the fix-issues effect in Board.tsx depends
  // on this identity to stay put across an unrelated App re-render.
  const consumeFixIssuesRequest = useCallback((): void => {
    setFixIssuesRequest(null);
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
  const { frame, streamDown } = useEventSource(streamUrl, StreamFrameSchema);

  // Clear the local override + optimistic overlay whenever SSE delivers a fresh snapshot. The optimistic
  // clear uses a functional guard so a zero-override poll (the steady state) doesn't force a re-render.
  useEffect(() => {
    setLocalBoardState(null);
    setOptimistic((m) => (m.size === 0 ? m : new Map()));
  }, [frame]);

  // Fetch the seed once per selected board. Cleared FIRST so a previous board's seed can never show
  // beneath a newly selected one, and never refreshed afterwards: SSE stays the only steady-state
  // source, and this is consulted last so it cannot mask a live frame.
  useEffect(() => {
    setSeedState(null);
    if (activeBoardId === null) return;
    let cancelled = false;
    api.state(activeBoardId)
      .then((s) => { if (!cancelled) setSeedState(s); })
      .catch((err: unknown) => { console.warn("[corral] board seed fetch failed; the board now depends on SSE alone", err); });
    return () => { cancelled = true; };
  }, [activeBoardId]);

  const fetchBoardState = useCallback((bid: string): void => {
    void api.state(bid).then(setLocalBoardState).catch(console.error);
  }, []);

  // useCallback (not a plain function): passed to Board as onBoardStateChange, which the fix-issues
  // effect depends on to guard against a duplicate api.tasks.create — an unrelated App re-render
  // (any SSE frame) must not hand that effect a new identity and re-fire it mid-request.
  const refreshBoards = useCallback((): void => {
    api.boards.list().then(setBoards).catch(console.error);
    if (activeBoardId !== null) fetchBoardState(activeBoardId);
  }, [activeBoardId, fetchBoardState]);

  const markOptimistic = useCallback((key: string, state: OptimisticState): void => {
    setOptimistic((m) => { const next = new Map(m); next.set(key, state); return next; });
  }, []);
  const clearOptimistic = useCallback((key: string): void => {
    setOptimistic((m) => { if (!m.has(key)) return m; const next = new Map(m); next.delete(key); return next; });
  }, []);

  // Precedence lives in lib/board-precedence (pure + tested): override, then live frame, then the
  // cold-start seed — and a frame that arrived at all supersedes the seed, including when it says the
  // board is gone. A single `??` swap here would silently turn the floor into a permanent mask.
  const activeBoardState = pickBoardState(localBoardState, frame, seedState);
  // Overlay optimistic close/resume intent before handing the board to the view (pure; see lib/optimistic).
  const boardStateForView = useMemo(
    () => (activeBoardState !== null && optimistic.size > 0
      ? { ...activeBoardState, tasks: applyOptimisticState(activeBoardState.tasks, optimistic) }
      : activeBoardState),
    [activeBoardState, optimistic],
  );
  // Attention + unassigned ride BOTH frame shapes; read them from whichever state is freshest.
  const globalState = pickGlobalState(localBoardState, frame, seedState);
  // Memoized so the derived-attention useMemos below get a stable dependency (the `?? {}` fallback
  // would otherwise mint a new object every render).
  const attention = useMemo(() => globalState?.attention ?? {}, [globalState]);
  const attentionCount = Object.keys(attention).length;
  const accounts = useMemo(() => (globalState !== null && "accounts" in globalState ? globalState.accounts : []), [globalState]);
  // Recap/statusline lookup for the live-terminal header's second line, keyed by `env:paneId` — covers
  // both unassigned rows and every task's enriched session link (`live` is null for a detached link).
  const liveByKey = useMemo(() => {
    // Carries the four registry fields plus `status`, which sessionStateLabel needs and SessionModal
    // does not otherwise have. `unassigned` rows are SessionRows and hold all five directly; a board
    // link holds them on `link.live` (LiveSessionData) after the projection.
    const m = new Map<string, {
      recap: string | null; recapStatus: RecapStatus | null; recapSource: RecapSource | null;
      statusline: StatuslineData | null; workspace: string;
      status: string; claudeStatus: string | null; claudeName: string | null; waitingFor: string | null;
      remoteControl: boolean | null; registryStatus: RegistryStatus | null;
    }>();
    // workspace (≈ repo) shown in the terminal header; "?" is herdr's unknown-label sentinel → drop it.
    const clean = (w: string): string => (w === "?" ? "" : w);
    for (const s of globalState?.unassigned ?? []) m.set(`${s.env}:${s.paneId}`, {
      recap: s.recap, recapStatus: s.recapStatus, recapSource: s.recapSource,
      statusline: s.statusline, workspace: clean(s.workspace),
      status: s.status, claudeStatus: s.claudeStatus, claudeName: s.claudeName, waitingFor: s.waitingFor,
      remoteControl: s.remoteControl, registryStatus: s.registryStatus,
    });
    if (activeBoardState !== null) {
      for (const t of activeBoardState.tasks) for (const link of t.sessions) {
        if (link.live !== null) m.set(`${link.env}:${link.paneId}`, {
          recap: link.live.recap, recapStatus: link.live.recapStatus, recapSource: link.live.recapSource,
          statusline: link.live.statusline, workspace: clean(link.workspaceLabel),
          status: link.live.status, claudeStatus: link.live.claudeStatus, claudeName: link.live.claudeName, waitingFor: link.live.waitingFor,
          remoteControl: link.live.remoteControl, registryStatus: link.live.registryStatus,
        });
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

  // Rejects on a server refusal (e.g. board_not_empty) so BoardSettingsModal's own catch keeps the
  // modal open and shows it — this function only runs on a CONFIRMED delete. Moves the user off the
  // deleted board onto whatever remains, or the empty state if it was the last one.
  async function handleDeleteBoard(boardId: string): Promise<void> {
    await api.boards.delete(boardId);
    const remaining = boards.filter((b) => b.id !== boardId);
    setBoards(remaining);
    if (activeBoardId === boardId) setActiveBoardId(remaining[0]?.id ?? null);
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
  // which made the button appear dead. The server resolves the landing column — `boards` here is
  // refreshed only by explicit fetches, so an out-of-band column change could leave it stale.
  async function handleNewTask(boardId: string, title: string): Promise<void> {
    try {
      await api.tasks.create(boardId, { title });
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
                pendingFixIssues={fixIssuesRequest}
                onFixIssuesConsumed={consumeFixIssuesRequest}
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

        {/* Unconditional: 🛟 must be reachable on the Unassigned view, before any board is selected, and
            on the "Failed to load boards" screen — the moment diagnostics matter most. 🔔 is board-scoped
            and hides itself; unassigned attention surfaces through the switcher badge by design. */}
        <SideRail
          diagnostics={globalState?.diagnostics ?? null}
          streamDown={streamDown}
          attention={attention}
          boards={boards}
          envs={globalState?.envs ?? {}}
          activeBoardId={activeBoardId}
          showUnassigned={showUnassigned}
          onOpen={openSession}
          onFixIssues={setFixIssuesRequest}
        />
      </div>

      {showSettings && activeBoardId !== null && activeBoardState !== null && (
        <BoardSettingsModal
          board={activeBoardState.board}
          onSave={(patch) => api.boards.update(activeBoardId, patch).then(() => { refreshBoards(); })}
          onDelete={() => handleDeleteBoard(activeBoardId)}
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
          recapStatus={liveByKey.get(`${session.env}:${session.paneId}`)?.recapStatus ?? null}
          recapSource={liveByKey.get(`${session.env}:${session.paneId}`)?.recapSource ?? null}
          statusline={liveByKey.get(`${session.env}:${session.paneId}`)?.statusline ?? null}
          claudeName={liveByKey.get(`${session.env}:${session.paneId}`)?.claudeName ?? null}
          status={liveByKey.get(`${session.env}:${session.paneId}`)?.status ?? "unknown"}
          claudeStatus={liveByKey.get(`${session.env}:${session.paneId}`)?.claudeStatus ?? null}
          waitingFor={liveByKey.get(`${session.env}:${session.paneId}`)?.waitingFor ?? null}
          remoteControl={liveByKey.get(`${session.env}:${session.paneId}`)?.remoteControl ?? null}
          registryStatus={liveByKey.get(`${session.env}:${session.paneId}`)?.registryStatus ?? null}
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
