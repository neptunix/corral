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
import type { Board as BoardType, BoardState, EnrichedTask } from "@shared/board-schema";
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { z } from "zod";

import { TaskCard } from "./TaskCard";
import { TaskEditModal } from "./TaskEditModal";
import { api } from "../lib/api";
import { overrideKey, type OptimisticState } from "../lib/optimistic";

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
  readonly onTaskEdit: (task: EnrichedTask) => void;
  readonly onOpenSession: (env: string, paneId: string, awaitAgent?: boolean, title?: string) => void;
  readonly onDetachSession: (taskId: string, env: string, paneId: string, sessionId: string | null) => void;
  readonly onCloseSession: (taskId: string, env: string, paneId: string, sessionId: string | null) => void;
  readonly onResumeSession: (taskId: string, env: string, paneId: string, sessionId: string | null) => void;
}

function DroppableColumn({ columnId, label, collapsible, tasks, onTaskEdit, onOpenSession, onDetachSession, onCloseSession, onResumeSession }: DroppableColumnProps): JSX.Element {
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
      <div ref={setNodeRef} className={`flex flex-col gap-2 flex-1 min-h-24 p-2 rounded-lg transition-colors ${isOver ? "bg-muted" : ""}`}>
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onEdit={() => { onTaskEdit(task); }}
            onOpenSession={onOpenSession}
            onDetachSession={(env, paneId, sessionId) => { onDetachSession(task.id, env, paneId, sessionId); }}
            onCloseSession={(env, paneId, sessionId) => { onCloseSession(task.id, env, paneId, sessionId); }}
            onResumeSession={(env, paneId, sessionId) => { onResumeSession(task.id, env, paneId, sessionId); }}
          />
        ))}
      </div>
    </div>
  );
}

interface Props {
  readonly boardState: BoardState;
  readonly boards: readonly BoardType[];
  readonly onBoardStateChange: () => void; // triggers re-fetch
  readonly onOpenSession: (env: string, paneId: string, awaitAgent?: boolean, title?: string) => void;
  readonly onMarkOptimistic: (key: string, state: OptimisticState) => void;
  readonly onClearOptimistic: (key: string) => void;
}

export function Board({ boardState, boards, onBoardStateChange, onOpenSession, onMarkOptimistic, onClearOptimistic }: Props): JSX.Element {
  const { board, tasks, envs } = boardState;
  const [editingTask, setEditingTask] = useState<EnrichedTask | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

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
  }, [board.id, tasks, onBoardStateChange]);

  const tasksByColumn = new Map<string, EnrichedTask[]>();
  for (const col of board.columns) tasksByColumn.set(col.id, []);
  for (const task of tasks) {
    const col = tasksByColumn.get(task.status);
    if (col !== undefined) col.push(task);
    else (tasksByColumn.get(board.columns[0]?.id ?? "") ?? []).push(task);
  }

  function handleSave(patch: Partial<Pick<EnrichedTask, "title" | "description" | "status" | "priority" | "repo">>): void {
    if (editingTask === null) return;
    void api.tasks.update(board.id, editingTask.id, patch).then(() => { onBoardStateChange(); });
  }

  function handleDelete(): void {
    if (editingTask === null) return;
    void api.tasks.delete(board.id, editingTask.id).then(() => {
      setEditingTask(null); // close the edit modal once the task is gone
      onBoardStateChange();
    });
  }

  function handleClose(): void {
    setEditingTask(null);
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
  // Flip the row to detached NOW (the /api/state re-fetch stays live-cached up to a poll); revert on error.
  function handleCloseSession(taskId: string, env: string, paneId: string, sessionId: string | null): void {
    const key = sessionKey(taskId, env, paneId, sessionId);
    if (key !== null) onMarkOptimistic(key, "closing");
    void api.tasks.close(board.id, taskId, env, paneId, sessionId)
      .then(() => { onBoardStateChange(); })
      .catch((err: unknown) => { if (key !== null) onClearOptimistic(key); console.error(err); });
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
    <div className="flex flex-col h-full">
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={(e) => { void handleDragEnd(e); }}>
        <div className="flex gap-4 p-4 overflow-x-auto flex-1">
          {board.columns.map((col) => (
            <DroppableColumn
              key={`${col.id}:${col.type ?? ""}`}
              columnId={col.id}
              label={col.label}
              collapsible={col.type === "closed"}
              tasks={tasksByColumn.get(col.id) ?? []}
              onTaskEdit={setEditingTask}
              onOpenSession={onOpenSession}
              onDetachSession={handleDetachSession}
              onCloseSession={handleCloseSession}
              onResumeSession={handleResumeSession}
            />
          ))}
        </div>
      </DndContext>

      {editingTask !== null && (
        <TaskEditModal
          task={editingTask}
          board={board}
          envIds={Object.keys(envs)}
          onSave={handleSave}
          onDelete={handleDelete}
          onSpawn={async ({ env, targetWorkspaceId, repo }) => {
            const link = await api.tasks.spawn(board.id, editingTask.id, env, targetWorkspaceId, repo);
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
        />
      )}
    </div>
  );
}
