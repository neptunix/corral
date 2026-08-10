import type { EnrichedTask, Board, Priority, SessionLink } from "@shared/board-schema";
import type { JSX } from "react";
import { useEffect, useState } from "react";

import type { SpawnEnvOption } from "./SpawnPanel";
import { SpawnPanel } from "./SpawnPanel";
import type { SpawnRequestBody } from "../lib/api";

interface Props {
  readonly task: EnrichedTask;
  readonly board: Board;
  readonly envs: readonly SpawnEnvOption[];
  // Rejects on a server refusal so handleSave can keep the modal open and show the message, instead
  // of closing on a failure it never saw (mirrors BoardSettingsModal's onSave contract).
  readonly onSave: (patch: Partial<Pick<EnrichedTask, "title" | "description" | "status" | "priority">>) => Promise<void>;
  // Same reject-on-refusal contract as onSave.
  readonly onDelete: () => Promise<void>;
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
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);

  useEffect(() => {
    // A save or delete in flight must not let a dismissal race its refusal — the same reason the
    // overlay click and Cancel button below are guarded.
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape" && !saving && !deleting) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [onClose, saving, deleting]);

  async function handleSave(): Promise<void> {
    setTaskError(null);
    setSaving(true);
    try {
      await onSave({ title: title.trim(), description, status, priority });
      onClose();
    } catch (err) {
      setTaskError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setTaskError(null);
    setDeleting(true);
    try {
      await onDelete();
      onClose();
    } catch (err) {
      setTaskError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" role="dialog" aria-modal="true"
      onClick={() => { if (!saving && !deleting) onClose(); }}>
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

        <label className="block text-xs text-muted-foreground mb-1">Description</label>
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
          presets={board.spawnPresets}
          defaultPresetId={board.defaultSpawnPresetId}
          hasSessions={task.sessions.length > 0}
          onSpawn={onSpawn}
          onSpawned={(link) => { onClose(); onOpenSession(link.env, link.paneId, true, task.title); }}
        />
        </div>

        <div className="flex flex-col gap-2 px-6 py-4 border-t border-border bg-card">
          {taskError !== null && <p className="text-xs text-destructive">{taskError}</p>}
          <div className="flex justify-between">
            {confirmDelete
              ? <div className="flex gap-2">
                  <span className="text-xs text-destructive self-center">Delete this task?</span>
                  <button onClick={() => { void handleDelete(); }} disabled={deleting || saving}
                    className="px-3 py-1.5 bg-destructive text-destructive-foreground text-xs rounded disabled:opacity-50">
                    {deleting ? "Deleting…" : "Confirm"}
                  </button>
                  <button onClick={() => { setConfirmDelete(false); }} disabled={deleting}
                    className="px-3 py-1.5 text-xs text-muted-foreground disabled:opacity-50">Cancel</button>
                </div>
              : <button onClick={() => { setConfirmDelete(true); }} className="text-xs text-destructive hover:text-destructive/80">Delete task</button>
            }
            <div className="flex gap-2">
              <button onClick={onClose} disabled={saving || deleting}
                className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">Cancel</button>
              <button onClick={() => { void handleSave(); }} disabled={saving || deleting}
                className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50">
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
