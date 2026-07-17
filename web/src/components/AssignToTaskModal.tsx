import type { Board } from "@shared/board-schema";
import { closedColumnIds } from "@shared/board-schema";
import type { SessionRow } from "@shared/schema";
import type { JSX } from "react";
import { useState } from "react";

interface Props {
  readonly boards: readonly Board[];
  readonly session: SessionRow;
  readonly onConfirm: (boardId: string, taskId: string) => void;
  readonly onClose: () => void;
}

// Bind an existing (live, unassigned) session to an existing task — the "assign to task" affordance on
// an Unassigned card. Board list carries its tasks (from api.boards.list), so the task picker needs no
// extra fetch. A card can already hold sessions; attach is idempotent and appends, giving 0..n per card.
export function AssignToTaskModal({ boards, session, onConfirm, onClose }: Props): JSX.Element {
  const [boardId, setBoardId] = useState(boards[0]?.id ?? "");
  const board = boards.find((b) => b.id === boardId) ?? boards[0];
  const closedIds = closedColumnIds(board?.columns ?? []);
  const tasks = (board?.tasks ?? []).filter((t) => !closedIds.has(t.status));
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? "");
  const label = session.tab !== "?" && session.tab !== "" ? session.tab : session.paneId;

  // Keep the task selection valid when the board changes: fall to that board's first non-closed task.
  const onBoardChange = (id: string): void => {
    setBoardId(id);
    const next = boards.find((b) => b.id === id);
    const openTasks = (next?.tasks ?? []).filter((t) => !closedColumnIds(next?.columns ?? []).has(t.status));
    setTaskId(openTasks[0]?.id ?? "");
  };
  const effectiveTaskId = tasks.some((t) => t.id === taskId) ? taskId : (tasks[0]?.id ?? "");
  const noTasks = tasks.length === 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg p-6 w-96" onClick={(e) => { e.stopPropagation(); }}>
        <h2 className="text-foreground font-semibold mb-1">Assign session to task</h2>
        <p className="text-xs text-muted-foreground mb-4 truncate">{label} · {session.env}</p>
        <label className="block text-xs text-muted-foreground mb-1">Board</label>
        <select
          className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm mb-3"
          value={boardId} onChange={(e) => { onBoardChange(e.target.value); }}
        >
          {boards.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
        </select>
        <label className="block text-xs text-muted-foreground mb-1">Task</label>
        <select
          className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm mb-4 disabled:opacity-50"
          value={effectiveTaskId} onChange={(e) => { setTaskId(e.target.value); }}
          disabled={noTasks}
        >
          {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        {noTasks && (
          <p className="text-xs text-warning mb-3">This board has no tasks — pick another board or create a task first.</p>
        )}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
          <button
            disabled={noTasks || effectiveTaskId === ""}
            onClick={() => { if (effectiveTaskId !== "") onConfirm(board?.id ?? boardId, effectiveTaskId); }}
            className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >Assign</button>
        </div>
      </div>
    </div>
  );
}
