import type { EnrichedTask, Board, Priority, SessionLink } from "@shared/board-schema";
import type { JSX } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { SpawnFields } from "./SpawnFields";
import type { SpawnRequestBody } from "../lib/api";
import type { SpawnEnvOption } from "../lib/use-spawn-form";
import { useSpawnForm } from "../lib/use-spawn-form";

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

// The description grows with its content instead of standing at a fixed 11 rows — an empty
// description used to cost ~230px and push the spawn action off a laptop screen entirely.
const DESC_LINE_HEIGHT = 20; // text-sm
const DESC_CHROME = 18; // py-2 + 1px borders
const DESC_MIN_ROWS = 3;
const DESC_MAX_ROWS = 12;

type Tab = "task" | "run";

export function TaskEditModal({ task, board, envs, onSave, onDelete, onSpawn, onOpenSession, boards, onMove, onClose }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>("task");
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
  const descRef = useRef<HTMLTextAreaElement>(null);

  // Spawn state lives HERE, not inside the fields, for two reasons: the submit button renders in this
  // modal's footer (so Save and the spawn action can never sit side by side and be misclicked), and the
  // state survives switching tabs, which unmounts the fields.
  const spawn = useSpawnForm({
    envs,
    presets: board.spawnPresets,
    defaultPresetId: board.defaultSpawnPresetId,
    onSpawn,
    onSpawned: (link) => { onClose(); onOpenSession(link.env, link.paneId, true, task.title); },
  });

  // Save is refused when nothing changed — the operator's actual complaint was hitting Save when they
  // meant to launch a session. BOTH sides are trimmed: handleSave sends the trimmed title, so a stored
  // title with surrounding whitespace (the server accepts one) would otherwise read as changed forever.
  const dirty = title.trim() !== task.title.trim()
    || description !== task.description
    || status !== task.status
    || priority !== task.priority;

  useEffect(() => {
    // A save, delete or spawn in flight must not let a dismissal race its refusal — the same reason the
    // overlay click and Cancel button below are guarded.
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape" && !saving && !deleting && !spawn.spawning) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [onClose, saving, deleting, spawn.spawning]);

  // Runs on tab change too: a textarea inside a just-mounted pane has to be measured after it is laid out.
  useLayoutEffect(() => {
    const el = descRef.current;
    if (el === null) return;
    const min = DESC_MIN_ROWS * DESC_LINE_HEIGHT + DESC_CHROME;
    const max = DESC_MAX_ROWS * DESC_LINE_HEIGHT + DESC_CHROME;
    el.style.height = "auto"; // shrink first, or scrollHeight only ever reports the current height
    const wanted = el.scrollHeight;
    el.style.height = `${String(Math.min(max, Math.max(min, wanted)))}px`;
    el.style.overflowY = wanted > max ? "auto" : "hidden";
  }, [description, tab]);

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

  const tabClass = (self: Tab, accent: boolean): string => {
    const base = "flex-1 sm:flex-none px-3.5 py-1.5 rounded-md text-sm whitespace-nowrap disabled:opacity-50";
    if (tab === self) return `${base} ${accent ? "bg-success/20 text-success font-semibold" : "bg-card text-foreground"}`;
    return `${base} ${accent ? "text-success font-semibold hover:bg-success/10" : "text-muted-foreground hover:text-foreground"}`;
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" role="dialog" aria-modal="true"
      onClick={() => { if (!saving && !deleting && !spawn.spawning) onClose(); }}>
      <div className="bg-card border border-border rounded-lg w-[min(900px,92vw)] max-h-[85vh] flex flex-col" onClick={(e) => { e.stopPropagation(); }}>

        <div className="flex flex-col gap-3 px-4 sm:px-6 pt-5 pb-3.5 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-foreground font-semibold">Edit task</h2>
          {/* Locked while a spawn is in flight: leaving this tab would put Save and Delete — both of
              which close the modal — back within reach of a click that would race the spawn's result. */}
          <div role="tablist" aria-label="Edit task sections" className="flex gap-[3px] p-[3px] bg-muted rounded-lg">
            <button role="tab" aria-selected={tab === "task"} disabled={spawn.spawning}
              onClick={() => { setTab("task"); }} className={tabClass("task", false)}>Task</button>
            <button role="tab" aria-selected={tab === "run"} disabled={spawn.spawning}
              onClick={() => { setTab("run"); }} className={tabClass("run", true)}>▶ Run Claude</button>
          </div>
        </div>

        <div className="px-4 sm:px-6 pb-5 overflow-y-auto flex-1">
          {tab === "task" ? (
            <div role="tabpanel">
              <div className="flex flex-col sm:flex-row gap-3 mb-3">
                <div className="flex-1 min-w-0">
                  <label className="block text-xs text-muted-foreground mb-1">Board / Project</label>
                  <div className="flex gap-2">
                    {/* min-w-0: a <select> won't shrink below its widest option on its own, so a long board
                        name would push the Move button out of this row and over the Column select beside
                        it (same family as ebd9d75's shrink-0-sibling overlap). */}
                    <select className="flex-1 min-w-0 bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm"
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
              {/* resize-none, not resize-y: the effect above owns the height and rewrites it on the next
                  keystroke, so a handle to drag would only promise a size that will not survive typing. */}
              <textarea ref={descRef} rows={DESC_MIN_ROWS}
                className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm mb-3 resize-none leading-5"
                value={description} onChange={(e) => { setDescription(e.target.value); }} />

              <label className="block text-xs text-muted-foreground mb-1">Priority</label>
              <div className="flex gap-2">
                {(["p0", "p1", "p2", "p3", null] as const).map((p) => (
                  <button key={String(p)} onClick={() => { setPriority(p); }}
                    className={`px-3 py-1 rounded text-xs font-mono ${priority === p ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                    {p === null ? "None" : p.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div role="tabpanel">
              <SpawnFields form={spawn} hasSessions={task.sessions.length > 0} />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 px-4 sm:px-6 py-4 border-t border-border bg-card">
          {taskError !== null && <p className="text-xs text-destructive">{taskError}</p>}
          {tab === "run" && spawn.error !== null && <p className="text-xs text-destructive whitespace-pre-wrap">{spawn.error}</p>}
          <div className="flex justify-between items-center gap-3">
            {confirmDelete
              ? <div className="flex gap-2">
                  <span className="text-xs text-destructive self-center">Delete this task?</span>
                  <button onClick={() => { void handleDelete(); }} disabled={deleting || saving || spawn.spawning}
                    className="px-3 py-1.5 bg-destructive text-destructive-foreground text-xs rounded disabled:opacity-50">
                    {deleting ? "Deleting…" : "Confirm"}
                  </button>
                  <button onClick={() => { setConfirmDelete(false); }} disabled={deleting}
                    className="px-3 py-1.5 text-xs text-muted-foreground disabled:opacity-50">Cancel</button>
                </div>
              : <button onClick={() => { setConfirmDelete(true); }} className="text-xs text-destructive hover:text-destructive/80">Delete task</button>
            }
            <div className="flex gap-2 items-center">
              {tab === "task" && !dirty && <span className="text-xs text-muted-foreground">no changes</span>}
              <button onClick={onClose} disabled={saving || deleting || spawn.spawning}
                className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">Cancel</button>
              {tab === "task"
                ? (
                  <button onClick={() => { void handleSave(); }} disabled={!dirty || saving || deleting || spawn.spawning}
                    className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50">
                    {saving ? "Saving…" : "Save"}
                  </button>
                )
                : (
                  <button onClick={() => { void spawn.submit(); }} disabled={spawn.spawning || !spawn.canSpawn}
                    className="px-4 py-2 bg-success text-success-foreground text-sm rounded hover:bg-success/90 disabled:opacity-50">
                    {spawn.spawning ? "Starting…" : "Run Claude"}
                  </button>
                )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
