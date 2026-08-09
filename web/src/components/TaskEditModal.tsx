import type { EnrichedTask, Board, Priority, SessionLink } from "@shared/board-schema";
import type { JSX } from "react";
import { useState } from "react";

import type { SpawnEnvOption } from "./SpawnPanel";
import { SpawnPanel } from "./SpawnPanel";
import type { SpawnRequestBody } from "../lib/api";

interface Props {
  readonly task: EnrichedTask;
  readonly board: Board;
  readonly envs: readonly SpawnEnvOption[];
  readonly onSave: (patch: Partial<Pick<EnrichedTask, "title" | "description" | "status" | "priority">>) => void;
  readonly onDelete: () => void;
  readonly onSpawn: (body: SpawnRequestBody) => Promise<SessionLink>;
  readonly onOpenSession: (env: string, paneId: string, awaitAgent?: boolean, title?: string) => void;
  readonly boards: readonly Board[];
  readonly onMove: (toBoardId: string) => Promise<void>;
  readonly onClose: () => void;
}

export function TaskEditModal({ task, board, envs, onSave, onDelete, onSpawn, onOpenSession, boards, onMove, onClose }: Props): JSX.Element {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [status, setStatus] = useState(task.status);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [targetBoardId, setTargetBoardId] = useState(board.id);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  function handleSave(): void {
    onSave({ title: title.trim(), description, status, priority });
    onClose();
  }

  async function handleMove(): Promise<void> {
    setMoving(true);
    setMoveError(null);
    try {
      await onMove(targetBoardId);
      onClose(); // the task leaves the current board's view
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : String(err));
      setTargetBoardId(board.id);
    } finally {
      setMoving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg w-[min(900px,92vw)] max-h-[80vh] flex flex-col" onClick={(e) => { e.stopPropagation(); }}>
        <h2 className="text-foreground font-semibold px-6 pt-6 pb-4">Edit task</h2>
        <div className="px-6 overflow-y-auto flex-1">

        <div className="flex gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <label className="block text-xs text-muted-foreground mb-1">Board / Project</label>
            <div className="flex gap-2">
              <select className="flex-1 bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm"
                value={targetBoardId} onChange={(e) => { setTargetBoardId(e.target.value); }}>
                {boards.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
              {targetBoardId !== board.id && (
                <button onClick={() => { void handleMove(); }} disabled={moving}
                  className="shrink-0 px-3 py-2 text-sm rounded border border-primary/60 text-primary hover:bg-primary/10 disabled:opacity-50">
                  {moving ? "Moving…" : "Move"}
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <label className="block text-xs text-muted-foreground mb-1">Column</label>
            <select className="w-full bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm"
              value={status} onChange={(e) => { setStatus(e.target.value); }}>
              {board.columns.map((col) => <option key={col.id} value={col.id}>{col.label}</option>)}
            </select>
          </div>
        </div>
        {moveError !== null && <p className="text-xs text-destructive mb-3">{moveError}</p>}

        <label className="block text-xs text-muted-foreground mb-1">Title</label>
        <input className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm mb-3"
          value={title} onChange={(e) => { setTitle(e.target.value); }} />

        <label className="block text-xs text-muted-foreground mb-1">Description (markdown)</label>
        <textarea rows={11} className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm mb-3 resize-y"
          value={description} onChange={(e) => { setDescription(e.target.value); }} />

        <label className="block text-xs text-muted-foreground mb-1">Priority</label>
        <div className="flex gap-2 mb-3">
          {(["p0", "p1", "p2", "p3", null] as const).map((p) => (
            <button key={String(p)} onClick={() => { setPriority(p); }}
              className={`px-3 py-1 rounded text-xs font-mono ${priority === p ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
              {p === null ? "None" : p.toUpperCase()}
            </button>
          ))}
        </div>

        <SpawnPanel
          envs={envs}
          hasSessions={task.sessions.length > 0}
          onSpawn={onSpawn}
          onSpawned={(link) => { onClose(); onOpenSession(link.env, link.paneId, true, task.title); }}
        />
        </div>

        <div className="flex justify-between px-6 py-4 border-t border-border bg-card">
          {confirmDelete
            ? <div className="flex gap-2">
                <span className="text-xs text-destructive self-center">Delete this task?</span>
                <button onClick={onDelete} className="px-3 py-1.5 bg-destructive text-destructive-foreground text-xs rounded">Confirm</button>
                <button onClick={() => { setConfirmDelete(false); }} className="px-3 py-1.5 text-xs text-muted-foreground">Cancel</button>
              </div>
            : <button onClick={() => { setConfirmDelete(true); }} className="text-xs text-destructive hover:text-destructive/80">Delete task</button>
          }
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
            <button onClick={handleSave} className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90">Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
