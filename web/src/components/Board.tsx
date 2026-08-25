import {
  DndContext,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import type { BoardFrame as BoardType, BoardState, EnrichedTask, SpawnPreset } from "@shared/board-schema";
import { closedColumnIds, defaultColumnId } from "@shared/board-schema";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { z } from "zod";

import { CloseCardSessionsModal, type CardSessionOffer } from "./CloseCardSessionsModal";
import { TaskCard } from "./TaskCard";
import type { Tab } from "./TaskEditModal";
import { TaskEditModal } from "./TaskEditModal";
import { ApiError, api } from "../lib/api";
import { overrideKey, type OptimisticState } from "../lib/optimistic";
import { sessionStateLabel, sessionStateTone } from "../lib/session-state";

// Zod schemas for drag data (data.current is Record<string, any>). Only task/column drags remain —
// session drag-to-attach (the old MiniPool) was removed; sessions attach via "Create task" now.
const TaskDragDataSchema = z.object({
  type: z.literal("task"),
  taskId: z.string(),
});

const ColumnDropDataSchema = z.object({
  type: z.literal("column"),
  columnId: z.string(),
});

interface DroppableColumnProps {
  readonly columnId: string;
  readonly label: string;
  readonly collapsible: boolean;
  readonly tasks: readonly EnrichedTask[];
  readonly boardId: string;
  // `tab` opens the modal on that section instead of the default (the card's log badge → "log").
  readonly onTaskEdit: (task: EnrichedTask, tab?: Tab) => void;
  readonly onOpenSession: (env: string, paneId: string, awaitAgent?: boolean, title?: string) => void;
  readonly onDetachSession: (taskId: string, env: string, paneId: string, sessionId: string | null) => void;
  readonly onCloseSession: (taskId: string, env: string, paneId: string, sessionId: string | null) => Promise<void>;
  readonly onResumeSession: (taskId: string, env: string, paneId: string, sessionId: string | null) => void;
}

function DroppableColumn({ columnId, label, collapsible, tasks, boardId, onTaskEdit, onOpenSession, onDetachSession, onCloseSession, onResumeSession }: DroppableColumnProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${columnId}`, data: { type: "column", columnId } });
  // Closed columns start collapsed on every load (in-memory only, no persistence). Toggle to peek.
  const [collapsed, setCollapsed] = useState(collapsible);

  if (collapsible && collapsed) {
    return (
      // Collapsed strip is BOTH click-to-expand and a drop target — a card can be dropped straight onto
      // it without expanding. The 8px drag-activation lives on the draggable card, so a real
      // drop is owned by the card's sensor and never fires this button's onClick.
      <button
        ref={setNodeRef}
        type="button"
        onClick={() => { setCollapsed(false); }}
        className={`flex flex-col items-center gap-2 shrink-0 w-10 py-3 rounded-lg transition-colors ${isOver ? "bg-muted ring-2 ring-primary" : "bg-muted/40 hover:bg-muted"}`}
        title={`Show ${label} — or drop a card here to move it in`}
      >
        <span className="text-muted-foreground text-xs">{tasks.length}</span>
        {/* Vertical label — market best-practice for a collapsed kanban column. */}
        <span
          className="text-muted-foreground text-sm font-medium whitespace-nowrap"
          style={{ writingMode: "vertical-rl" }}
        >{label}</span>
      </button>
    );
  }

  return (
    <div className="flex flex-col min-w-[240px] flex-1">
      <h3 className="text-muted-foreground text-sm font-medium px-2 pb-2 flex items-center justify-between">
        <span>{label}</span>
        {collapsible && (
          <button
            type="button"
            onClick={() => { setCollapsed(true); }}
            className="text-muted-foreground hover:text-foreground text-xs leading-none px-1"
            title={`Collapse ${label}`}
          >‹‹</button>
        )}
      </h3>
      {/* Each column scrolls its OWN cards (the board scrolls horizontally only). This is what keeps
          drag-and-drop honest: dnd-kit measures a drop target with getBoundingClientRect(), so when a
          column's cards spilled out of a box clamped to the visible height, anything dropped on the
          scrolled-past part fell outside every droppable rect and `pointerWithin` reported no target —
          handleDragEnd then returned silently. Scrolling here makes the drop target and the scroll
          viewport the same box, so the pointer is always inside it. It also keeps the column heading
          above in view instead of scrolling away with the cards. */}
      <div ref={setNodeRef} className={`flex flex-col gap-2 flex-1 min-h-24 overflow-y-auto p-2 rounded-lg transition-colors ${isOver ? "bg-muted" : ""}`}>
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            boardId={boardId}
            onEdit={() => { onTaskEdit(task); }}
            onOpenLog={() => { onTaskEdit(task, "log"); }}
            onOpenSession={onOpenSession}
            onDetachSession={(env, paneId, sessionId) => { onDetachSession(task.id, env, paneId, sessionId); }}
            onCloseSession={(env, paneId, sessionId) => onCloseSession(task.id, env, paneId, sessionId)}
            onResumeSession={(env, paneId, sessionId) => { onResumeSession(task.id, env, paneId, sessionId); }}
          />
        ))}
      </div>
    </div>
  );
}

type TaskPatch = Partial<Pick<EnrichedTask, "title" | "description" | "status" | "priority">>;

/** Whether a patch would actually change the card. A patch that changes nothing is not worth a write. */
function changesTask(task: EnrichedTask, patch: TaskPatch): boolean {
  return (patch.title !== undefined && patch.title !== task.title)
    || (patch.description !== undefined && patch.description !== task.description)
    || (patch.status !== undefined && patch.status !== task.status)
    || (patch.priority !== undefined && patch.priority !== task.priority);
}

/** A move into a closed column, held unwritten until the operator answers for the sessions on it. */
interface ClosedMove {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly status: string;
  readonly columnLabel: string;
  readonly sessions: readonly CardSessionOffer[];
}

interface Props {
  readonly boardState: BoardState;
  readonly boards: readonly BoardType[];
  readonly onBoardStateChange: () => void; // triggers re-fetch
  readonly onOpenSession: (env: string, paneId: string, awaitAgent?: boolean, title?: string) => void;
  readonly onMarkOptimistic: (key: string, state: OptimisticState) => void;
  readonly onClearOptimistic: (key: string) => void;
  // The Health panel's "Fix issues" click, relayed from App (SideRail is this component's sibling,
  // not its child). Consumed once: creates an ad-hoc task, opens it straight to the Run tab with
  // `preset` pre-selected, then calls onFixIssuesConsumed so a re-render never repeats the create.
  readonly pendingFixIssues: { readonly title: string; readonly description: string; readonly preset: SpawnPreset } | null;
  readonly onFixIssuesConsumed: () => void;
}

export function Board({
  boardState, boards, onBoardStateChange, onOpenSession, onMarkOptimistic, onClearOptimistic,
  pendingFixIssues, onFixIssuesConsumed,
}: Props): JSX.Element {
  const { board, tasks, envs } = boardState;
  const [editingTask, setEditingTask] = useState<EnrichedTask | null>(null);
  // Set alongside editingTask only by the fix-issues flow below; TaskEditModal renders it as an
  // ephemeral, unsaved preset ahead of `board.spawnPresets` and pre-selects it. Cleared with the modal.
  const [fixPreset, setFixPreset] = useState<SpawnPreset | null>(null);
  // The section the modal opens on; set with editingTask by the card's log badge, cleared with it.
  const [editingTab, setEditingTab] = useState<Tab | undefined>(undefined);
  // A move into a closed column that is waiting to be confirmed, because live sessions are attached.
  // NOTHING is written while this is set — the card has not moved (see CloseCardSessionsModal).
  const [pendingMove, setPendingMove] = useState<ClosedMove | null>(null);

  // Mutated during render, read inside the effect's async callback below — the "latest ref" pattern.
  // NOT a dependency: reading a fresher board.id at resolve time is the point, not re-running on it.
  const latestBoardId = useRef(board.id);
  latestBoardId.current = board.id;

  useEffect(() => {
    if (pendingFixIssues === null) return;
    const request = pendingFixIssues;
    const requestBoardId = board.id;
    // Consumed SYNCHRONOUSLY, before the request ever reaches the network. A consume tied to promise
    // settlement (the previous shape here) left the request stuck in App's state forever whenever this
    // effect's run never got to finish uncancelled (the operator navigates away mid-request) — the
    // NEXT mount would then fire create AGAIN for the same click. Consuming here means the request is
    // spent the instant it is seen, independent of how this run ends.
    //
    // That synchronous consume itself immediately re-renders App with pendingFixIssues cleared, which
    // is a DEP CHANGE this same effect reacts to — an earlier version guarded the success path on a
    // `cancelled` flag flipped by this effect's own cleanup, which that self-triggered re-render trips
    // before the network call ever returns: the task got created, but the modal never opened and
    // nothing else fired. `cancelled` conflated "this effect's deps changed" with "the operator moved
    // to different board" — only the latter should block opening the modal.
    onFixIssuesConsumed();
    api.tasks.create(board.id, { title: request.title, description: request.description })
      .then((created) => {
        onBoardStateChange();
        // A genuine board switch since the request was made — DON'T show board A's new task while
        // this instance is now rendering board B. Anything else (this effect's own consume re-running
        // it, or true unmount) is safe to fall through: React 18 no-ops a state update on an unmounted
        // component, and a re-run with the SAME board must still open the modal.
        if (latestBoardId.current !== requestBoardId) return;
        // The route answers with the frame shape, which carries the log as two counters. A card this
        // call just created has no entries, so both are their empty values.
        setEditingTask({ ...created, sessions: [], logCount: 0, lastLogAtMs: null });
        setFixPreset(request.preset);
      })
      .catch((err: unknown) => {
        window.alert(`Create task failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, [pendingFixIssues, board.id, onBoardStateChange, onFixIssuesConsumed]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  // A card landing in a closed column is the operator saying the work is over — the sessions on it
  // usually are too, but nothing closes them today, so they linger as orphan panes. Ask FIRST: the
  // status write happens only if they answer, so cancelling leaves the card where it was. Returns the
  // pending move to confirm, or null when the move needs no question and can just be written.
  const moveNeedingConfirmation = useCallback((taskId: string, newStatus: string): ClosedMove | null => {
    if (!closedColumnIds(board.columns).has(newStatus)) return null;
    const task = tasks.find((t) => t.id === taskId);
    if (task === undefined) return null;
    // Detached links are sessions that already ended. Without this filter every card drifting into a
    // closed column — a tracking strip, an archive — would ask a question with nothing behind it.
    const live = task.sessions.filter((s) => s.live !== null && !s.live.detached);
    if (live.length === 0) return null;
    return {
      taskId,
      taskTitle: task.title,
      status: newStatus,
      // Snapshotted with the rest: the dialog names the column the card is headed for, which a later
      // board refresh must not rewrite under it.
      columnLabel: board.columns.find((c) => c.id === newStatus)?.label ?? newStatus,
      sessions: live.map((s) => ({
        env: s.env, paneId: s.paneId, sessionId: s.sessionId, name: s.name,
        tone: sessionStateTone(s.live), label: sessionStateLabel(s.live),
      })),
    };
  }, [board.columns, tasks]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null) return;

    const taskDragResult = TaskDragDataSchema.safeParse(active.data.current);
    if (taskDragResult.success) {
      // Column-move flow
      const taskId = taskDragResult.data.taskId;

      const overColResult = ColumnDropDataSchema.safeParse(over.data.current);
      const overId = over.id;
      const newColumnId = overColResult.success
        ? overColResult.data.columnId
        : typeof overId === "string"
          ? overId.replace("col:", "")
          : "";

      if (newColumnId !== "" && tasks.find((t) => t.id === taskId)?.status !== newColumnId) {
        const pending = moveNeedingConfirmation(taskId, newColumnId);
        // Nothing is written yet — the card snaps back to its column until the dialog is answered.
        if (pending !== null) { setPendingMove(pending); return; }
        try {
          await api.tasks.update(board.id, taskId, { status: newColumnId });
        } catch (err) {
          // A failed move otherwise just snaps back with no feedback (the card wasn't optimistically
          // persisted). Surface it, then re-sync to the server's truth like the other handlers.
          window.alert(`Move failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        onBoardStateChange();
      }
    }
  }, [board.id, tasks, onBoardStateChange, moveNeedingConfirmation]);

  const tasksByColumn = new Map<string, EnrichedTask[]>();
  for (const col of board.columns) tasksByColumn.set(col.id, []);
  for (const task of tasks) {
    const col = tasksByColumn.get(task.status);
    if (col !== undefined) col.push(task);
    else (tasksByColumn.get(defaultColumnId(board.columns) ?? "") ?? []).push(task);
  }

  // Rejects on a server refusal so TaskEditModal's own catch keeps the modal open and shows the
  // message, instead of closing on a failure it never saw (mirrors BoardSettingsModal's onSave).
  function handleSave(patch: Partial<Pick<EnrichedTask, "title" | "description" | "status" | "priority">>): Promise<void> {
    if (editingTask === null) return Promise.resolve();
    // The modal submits every field, changed or not, so compare before asking — otherwise renaming a
    // card that already sits in a closed column would ask about its sessions again.
    const { id: taskId, status: wasStatus } = editingTask;
    const pending = patch.status !== undefined && patch.status !== wasStatus
      ? moveNeedingConfirmation(taskId, patch.status)
      : null;
    // Save everything EXCEPT the move when the move needs confirming: dropping the whole save would
    // throw away title and description edits made in the same submit, which nobody asked about. When
    // the move is the ONLY change there is nothing left to save — and writing the patch anyway would
    // bump `updatedAt` on a card that never moved, so cancelling would still have edited it.
    const immediate = pending === null ? patch : { ...patch, status: wasStatus };
    const nothingToSave = pending !== null && !changesTask(editingTask, immediate);
    if (nothingToSave) { setPendingMove(pending); return Promise.resolve(); }
    return api.tasks.update(board.id, taskId, immediate).then(() => {
      onBoardStateChange();
      if (pending !== null) setPendingMove(pending);
    });
  }

  // Same reject-on-refusal contract as onSave. Closing is TaskEditModal's job (it calls onClose once
  // this resolves) — this only runs the delete and refreshes state, so a refusal never gets a chance
  // to race an unconditional close.
  function handleDelete(): Promise<void> {
    if (editingTask === null) return Promise.resolve();
    return api.tasks.delete(board.id, editingTask.id).then(() => { onBoardStateChange(); });
  }

  function handleClose(): void {
    setEditingTask(null);
    setFixPreset(null);
    setEditingTab(undefined);
  }

  // Remove a single session link from a task (the ✕ on a session row). Uses the existing detach route;
  // the session itself is untouched (it just becomes unassigned again). Refresh to reflect the drop.
  function handleDetachSession(taskId: string, env: string, paneId: string, sessionId: string | null): void {
    void api.tasks.detach(board.id, taskId, env, paneId, sessionId)
      .then(() => { onBoardStateChange(); })
      .catch((err: unknown) => { window.alert(`Detach failed: ${err instanceof Error ? err.message : String(err)}`); });
  }

  // The optimistic override key for a session row, resolved from the current board (id-first via
  // overrideKey, so a resume that rebinds the paneId keeps its override). null if the link vanished.
  // Resolves by sessionId when present (stable across a pane rebind); falls back to env/paneId otherwise.
  function sessionKey(taskId: string, env: string, paneId: string, sessionId: string | null): string | null {
    const link = tasks.find((t) => t.id === taskId)?.sessions.find((s) =>
      sessionId !== null && sessionId !== "" ? s.sessionId === sessionId : (s.env === env && s.paneId === paneId));
    return link === undefined ? null : overrideKey(link);
  }

  // Close = kill the herdr tab but keep the task→session link; the session goes detached on next poll.
  // Returns a promise (the close modal awaits it) and rethrows on failure so the modal can show the error.
  async function handleCloseSession(taskId: string, env: string, paneId: string, sessionId: string | null): Promise<void> {
    const key = sessionKey(taskId, env, paneId, sessionId);
    if (key !== null) onMarkOptimistic(key, "closing");
    try {
      await api.tasks.close(board.id, taskId, env, paneId, sessionId);
    } catch (err) {
      // `no_live_pane` is the END STATE, not a failure: the pane is already gone. Liveness on the
      // board is up to one poll old, and the session may have been closed from the terminal, from
      // another tab, or a moment ago from here — so a close arriving late must not report an error
      // for having got what it asked for. Only refusals about a DIFFERENT session (`pane_reused`) or
      // a broken request stay errors.
      if (!(err instanceof ApiError && err.code === "no_live_pane")) {
        if (key !== null) onClearOptimistic(key);
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
    onBoardStateChange();
  }

  // Resume = restart a detached session (`claude --resume <uuid>`), rebinding the link to the new pane,
  // then auto-open it (mirrors the post-spawn auto-open in TaskEditModal's onSpawn flow). Flip the row to
  // live immediately; revert on error.
  function handleResumeSession(taskId: string, env: string, paneId: string, sessionId: string | null): void {
    const title = tasks.find((t) => t.id === taskId)?.title;
    const key = sessionKey(taskId, env, paneId, sessionId);
    if (key !== null) onMarkOptimistic(key, "resuming");
    void api.tasks.resume(board.id, taskId, env, paneId, sessionId).then((link) => {
      onBoardStateChange();
      onOpenSession(link.env, link.paneId, true, title);
    }).catch((err: unknown) => { if (key !== null) onClearOptimistic(key); console.error(err); });
  }

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={(e) => { void handleDragEnd(e); }}>
        {/* The board's only scroll container, in BOTH axes: a non-visible `overflow-x` forces
            `overflow-y` to compute to `auto` as well (CSS Overflow 3). `flex-1` (never `h-full`) is
            what makes it fit: it is a flex item of a column that ALSO holds the board-title row, so
            height:100% would overflow that column by the title's height and the column clips
            (overflow-hidden) — which is how the bottom of this scroll viewport went missing. No
            `min-h-0` needed to defeat the flex auto-min floor: a scroll container's is already 0. */}
        <div className="flex gap-4 p-4 overflow-x-auto flex-1">
          {board.columns.map((col) => (
            <DroppableColumn
              key={`${col.id}:${col.type ?? ""}`}
              columnId={col.id}
              label={col.label}
              collapsible={col.type === "closed"}
              tasks={tasksByColumn.get(col.id) ?? []}
              boardId={board.id}
              onTaskEdit={(task, tab) => { setEditingTask(task); setEditingTab(tab); }}
              onOpenSession={onOpenSession}
              onDetachSession={handleDetachSession}
              onCloseSession={handleCloseSession}
              onResumeSession={handleResumeSession}
            />
          ))}
        </div>
      </DndContext>

      {editingTask !== null && (
        // Keyed on task id: without it, the fix-issues effect swapping editingTask while a DIFFERENT
        // task's modal is already open reuses this instance instead of remounting it, so its
        // useState(task.x) field initializers keep the old task's stale values under the new task's id.
        <TaskEditModal
          key={editingTask.id}
          task={editingTask}
          board={board}
          envs={Object.entries(envs).map(([id, e]) => ({ id, label: e.label ?? id, kind: e.kind ?? null, reachable: e.reachable }))}
          onSave={handleSave}
          onDelete={handleDelete}
          onSpawn={async (body) => {
            const link = await api.tasks.spawn(board.id, editingTask.id, body);
            onBoardStateChange();
            return link;
          }}
          onOpenSession={onOpenSession}
          boards={boards}
          onMove={async (toBoardId) => {
            await api.tasks.move(board.id, editingTask.id, toBoardId);
            onBoardStateChange();
          }}
          onClose={handleClose}
          initialTab={fixPreset === null ? editingTab : "run"}
          extraPreset={fixPreset}
        />
      )}

      {pendingMove !== null && (
        <CloseCardSessionsModal
          taskTitle={pendingMove.taskTitle}
          columnLabel={pendingMove.columnLabel}
          sessions={pendingMove.sessions}
          onMove={async () => {
            await api.tasks.update(board.id, pendingMove.taskId, { status: pendingMove.status });
            onBoardStateChange();
          }}
          onCloseOne={(s) => handleCloseSession(pendingMove.taskId, s.env, s.paneId, s.sessionId)}
          onDismiss={() => { setPendingMove(null); }}
        />
      )}
    </>
  );
}
