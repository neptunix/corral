import type { EnrichedTask, Board, Priority, SessionLink } from "@shared/board-schema";
import type { JSX } from "react";
import { useEffect, useState } from "react";

import { api } from "../lib/api";

interface Props {
  readonly task: EnrichedTask;
  readonly board: Board;
  readonly envIds: readonly string[];
  readonly onSave: (patch: Partial<Pick<EnrichedTask, "title" | "description" | "status" | "priority" | "repo">>) => void;
  readonly onDelete: () => void;
  readonly onSpawn: (args: { env: string; targetWorkspaceId: string | null; repo: string | null }) => Promise<SessionLink>;
  readonly onOpenSession: (env: string, paneId: string, awaitAgent?: boolean, title?: string) => void;
  readonly boards: readonly Board[];
  readonly onMove: (toBoardId: string) => Promise<void>;
  readonly onClose: () => void;
}

export function TaskEditModal({ task, board, envIds, onSave, onDelete, onSpawn, onOpenSession, boards, onMove, onClose }: Props): JSX.Element {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  // The free-text Repo input was removed (redundant now the "Into" picker sources repos).
  // `task.repo` still seeds the spawn-picker's default selection below, so keep it as a derived value;
  // it's no longer edited here and no longer written on Save (so an empty field can't clobber it).
  const repo = task.repo ?? "";
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [status, setStatus] = useState(task.status);
  const [spawning, setSpawning] = useState(false);
  const [spawnEnv, setSpawnEnv] = useState(envIds[0] ?? "");
  // Spawn "Into" targets: existing herdr spaces (join) + the env's configured repos (create new).
  const [targets, setTargets] = useState<{ readonly spaces: readonly { workspaceId: string; label: string }[]; readonly repos: readonly { name: string }[] }>({ spaces: [], repos: [] });
  const [selectedTarget, setSelectedTarget] = useState<string>(""); // a workspaceId (join) or "new:<repo>" (create)
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [targetBoardId, setTargetBoardId] = useState(board.id);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  // Fetch spawn targets for the chosen env (unreachable env → no join spaces, but configured repos still show).
  useEffect(() => {
    let cancelled = false;
    if (spawnEnv === "") { setTargets({ spaces: [], repos: [] }); return; }
    api.envs.spawnTargets(spawnEnv)
      .then((t) => { if (!cancelled) setTargets(t); })
      .catch(() => { if (!cancelled) setTargets({ spaces: [], repos: [] }); });
    return () => { cancelled = true; };
  }, [spawnEnv]);

  // A configured repo that already has a same-named space isn't offered as "new" — you'd join instead.
  const spaceLabels = new Set(targets.spaces.map((s) => s.label.toLowerCase()));
  const newRepoOptions = targets.repos.filter((r) => !spaceLabels.has(r.name.toLowerCase()));

  // Default the picker from the Repo field: matching existing space → join it; else matching configured
  // repo → "new from" it; else the first available target (existing space, then a new-from-repo).
  useEffect(() => {
    const r = repo.trim().toLowerCase();
    const matchSpace = r !== "" ? targets.spaces.find((s) => s.label.toLowerCase() === r) : undefined;
    if (matchSpace !== undefined) { setSelectedTarget(matchSpace.workspaceId); return; }
    const matchRepo = r !== "" ? targets.repos.find((x) => x.name.toLowerCase() === r) : undefined;
    if (matchRepo !== undefined) { setSelectedTarget(`new:${matchRepo.name}`); return; }
    const firstRepo = targets.repos[0];
    setSelectedTarget(targets.spaces[0]?.workspaceId ?? (firstRepo !== undefined ? `new:${firstRepo.name}` : ""));
  }, [targets, repo]);

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

  async function handleSpawn(): Promise<void> {
    setSpawning(true);
    setSpawnError(null);
    try {
      // Target value is either an existing workspaceId (join) or "new:<repo>" (create a space at the
      // repo's configured path).
      const isNew = selectedTarget.startsWith("new:");
      const targetWorkspaceId = isNew ? null : selectedTarget;
      const repoArg = isNew ? selectedTarget.slice(4) : null;
      const link = await onSpawn({ env: spawnEnv, targetWorkspaceId, repo: repoArg });
      onClose();
      onOpenSession(link.env, link.paneId, true, task.title); // auto-attach; retry until claude registers as an agent
    } catch (err) {
      setSpawnError(err instanceof Error ? err.message : String(err));
    } finally {
      setSpawning(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg p-6 w-[480px] max-h-[80vh] overflow-y-auto" onClick={(e) => { e.stopPropagation(); }}>
        <h2 className="text-foreground font-semibold mb-4">Edit task</h2>

        <label className="block text-xs text-muted-foreground mb-1">Board / Project</label>
        <div className="flex gap-2 mb-3">
          <select className="flex-1 bg-background border border-border rounded px-3 py-2 text-foreground text-sm"
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
        {moveError !== null && <p className="text-xs text-destructive mb-3">{moveError}</p>}

        <label className="block text-xs text-muted-foreground mb-1">Title</label>
        <input className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm mb-3"
          value={title} onChange={(e) => { setTitle(e.target.value); }} />

        <label className="block text-xs text-muted-foreground mb-1">Description (markdown)</label>
        <textarea rows={4} className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm mb-3 resize-none"
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

        <label className="block text-xs text-muted-foreground mb-1">Column</label>
        <select className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm mb-4"
          value={status} onChange={(e) => { setStatus(e.target.value); }}>
          {board.columns.map((col) => <option key={col.id} value={col.id}>{col.label}</option>)}
        </select>

        {(() => {
          const noTargets = targets.spaces.length === 0 && newRepoOptions.length === 0;
          const canSpawn = spawnEnv !== "" && selectedTarget !== "";
          return (
            <div className="mb-4 p-3 bg-muted rounded">
              <p className="text-xs text-muted-foreground mb-2">
                {task.sessions.length > 0 ? "Spawn another session" : "Spawn a new session"}
              </p>
              <div className="flex gap-2 mb-1">
                <select className="w-32 shrink-0 bg-background border border-border rounded px-2 py-1.5 text-foreground text-sm"
                  value={spawnEnv} onChange={(e) => { setSpawnEnv(e.target.value); }} title="Environment">
                  {envIds.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
                <select className="flex-1 min-w-0 bg-background border border-border rounded px-2 py-1.5 text-foreground text-sm"
                  value={selectedTarget} onChange={(e) => { setSelectedTarget(e.target.value); }} title="Where the session runs" disabled={noTargets}>
                  {targets.spaces.length > 0 && (
                    <optgroup label="Existing spaces (join)">
                      {targets.spaces.map((s) => <option key={s.workspaceId} value={s.workspaceId}>{s.label}</option>)}
                    </optgroup>
                  )}
                  {newRepoOptions.length > 0 && (
                    <optgroup label="New space from repo">
                      {newRepoOptions.map((r) => <option key={r.name} value={`new:${r.name}`}>＋ {r.name}</option>)}
                    </optgroup>
                  )}
                </select>
                <button onClick={() => { void handleSpawn(); }} disabled={spawning || !canSpawn}
                  className="shrink-0 px-3 py-1.5 bg-success text-success-foreground text-sm rounded hover:bg-success/90 disabled:opacity-50">
                  {spawning ? "Spawning…" : "Spawn"}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">Into an existing herdr space, or a new one from a repo in <span className="text-foreground/80 font-mono">environments.json</span>.</p>
              {noTargets && spawnError === null && (
                <p className="text-xs text-muted-foreground mt-1">No spaces or configured repos for this env — add repos to its <span className="font-mono">environments.json</span> entry, or create a space in herdr.</p>
              )}
              {spawnError !== null && (
                <p className="text-xs text-destructive whitespace-pre-wrap mt-1">{spawnError}</p>
              )}
            </div>
          );
        })()}

        <div className="flex justify-between">
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
