import type { SessionLink } from "@shared/board-schema";
import type { JSX } from "react";
import { useEffect, useState } from "react";

import type { SpawnRequestBody } from "../lib/api";
import { api } from "../lib/api";

export interface SpawnEnvOption {
  readonly id: string;
  readonly label: string;
  readonly kind: "local" | "remote" | null; // null = unknown → treated as NOT local
}

// A three-state fetch, not a boolean: "ready" with zero spaces/repos is a settled, genuinely empty
// result, distinct from still-loading or failed. Collapsing that into a boolean is what the panel
// used to do, and it is why an empty env and a slow env used to render identically.
type TargetsState =
  | { readonly phase: "loading" }
  | { readonly phase: "error"; readonly message: string }
  | { readonly phase: "ready"; readonly spaces: readonly { workspaceId: string; label: string }[]; readonly repos: readonly { name: string }[] };

export interface SpawnPanelProps {
  readonly envs: readonly SpawnEnvOption[];
  readonly hasSessions: boolean; // "Spawn another session" vs "Spawn a new session"
  readonly onSpawn: (body: SpawnRequestBody) => Promise<SessionLink>;
  readonly onSpawned: (link: SessionLink) => void; // the modal closes + auto-attaches
}

export function SpawnPanel({ envs, hasSessions, onSpawn, onSpawned }: SpawnPanelProps): JSX.Element {
  const [spawning, setSpawning] = useState(false);
  const [spawnEnv, setSpawnEnv] = useState(envs[0]?.id ?? "");
  // "" is the picker's "default" — no model field is sent, so the session inherits the last-used one.
  const [spawnModel, setSpawnModel] = useState("");
  // Unchecked by default, and deliberately NOT persisted between spawns: ticking it connects the new
  // session to claude.ai, so it is an explicit decision every time (spec A.1).
  const [spawnRemoteControl, setSpawnRemoteControl] = useState(false);
  // Spawn "Into" targets: existing herdr spaces (join) + the env's configured repos (create new).
  const [targets, setTargets] = useState<TargetsState>({ phase: "loading" });
  const [selectedTarget, setSelectedTarget] = useState<string>(""); // a workspaceId (join) or "new:<repo>" (create)
  const [spawnError, setSpawnError] = useState<string | null>(null);

  // Fetch spawn targets for the chosen env (unreachable env → error phase; configured repos still show
  // once reachable). Cleared to "loading" IMMEDIATELY on env change, so a space belonging to the
  // previous env is never briefly selectable and the misconfiguration text cannot render over an
  // in-flight fetch.
  useEffect(() => {
    let cancelled = false;
    if (spawnEnv === "") { setTargets({ phase: "ready", spaces: [], repos: [] }); return; }
    setTargets({ phase: "loading" });
    api.envs.spawnTargets(spawnEnv)
      .then((t) => { if (!cancelled) setTargets({ phase: "ready", spaces: t.spaces, repos: t.repos }); })
      .catch((err: unknown) => {
        if (!cancelled) setTargets({ phase: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [spawnEnv]);

  const ready = targets.phase === "ready" ? targets : null;
  // A configured repo that already has a same-named space isn't offered as "new" — you'd join instead.
  const spaceLabels = new Set((ready?.spaces ?? []).map((s) => s.label.toLowerCase()));
  const newRepoOptions = (ready?.repos ?? []).filter((r) => !spaceLabels.has(r.name.toLowerCase()));
  // "Empty" is a READY state, never a loading one — that distinction is the point of this task.
  const noTargets = ready !== null && ready.spaces.length === 0 && newRepoOptions.length === 0;

  // Default the picker to the first available target — an existing space, else a new-from-repo.
  useEffect(() => {
    if (targets.phase !== "ready") { setSelectedTarget(""); return; }
    const firstRepo = targets.repos[0];
    setSelectedTarget(targets.spaces[0]?.workspaceId ?? (firstRepo !== undefined ? `new:${firstRepo.name}` : ""));
  }, [targets]);

  const canSpawn = targets.phase === "ready" && spawnEnv !== "" && selectedTarget !== "";

  async function handleSpawn(): Promise<void> {
    setSpawning(true);
    setSpawnError(null);
    try {
      // Target value is either an existing workspaceId (join) or "new:<repo>" (create a space at the
      // repo's configured path).
      const isNew = selectedTarget.startsWith("new:");
      const targetWorkspaceId = isNew ? null : selectedTarget;
      const repoArg = isNew ? selectedTarget.slice(4) : null;
      const link = await onSpawn({
        env: spawnEnv,
        targetWorkspaceId,
        repo: repoArg,
        ...(spawnModel === "" ? {} : { model: spawnModel }),
        ...(spawnRemoteControl ? { remoteControl: true } : {}),
      });
      onSpawned(link);
    } catch (err) {
      setSpawnError(err instanceof Error ? err.message : String(err));
    } finally {
      setSpawning(false);
    }
  }

  return (
    <div className="mb-4 p-3 bg-muted rounded">
      <p className="text-xs text-muted-foreground mb-2">
        {hasSessions ? "Spawn another session" : "Spawn a new session"}
      </p>

      <div className="flex gap-3 mb-1">
        <div className="shrink-0 w-[200px]">
          <label className="block text-xs text-muted-foreground mb-1">Environment</label>
          <select
            className="w-full bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm"
            value={spawnEnv}
            onChange={(e) => { setSpawnEnv(e.target.value); }}
          >
            {envs.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </div>

        <div className="flex-1 min-w-0">
          <label className="block text-xs text-muted-foreground mb-1">Where it runs</label>
          <select
            className="w-full bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm"
            value={selectedTarget}
            onChange={(e) => { setSelectedTarget(e.target.value); }}
            disabled={targets.phase !== "ready" || noTargets}
          >
            {ready !== null && ready.spaces.length > 0 && (
              <optgroup label="Existing spaces (join)">
                {ready.spaces.map((s) => <option key={s.workspaceId} value={s.workspaceId}>{s.label}</option>)}
              </optgroup>
            )}
            {newRepoOptions.length > 0 && (
              <optgroup label="New space from repo">
                {newRepoOptions.map((r) => <option key={r.name} value={`new:${r.name}`}>＋ {r.name}</option>)}
              </optgroup>
            )}
          </select>
          {targets.phase === "loading" && (
            <p className="text-xs text-muted-foreground mt-1">Loading targets…</p>
          )}
          {targets.phase === "error" && (
            <p className="text-xs text-destructive mt-1">Could not reach this environment — {targets.message}</p>
          )}
          {noTargets && (
            <p className="text-xs text-muted-foreground mt-1">No spaces or configured repos for this env — add repos to its <span className="font-mono">environments.json</span> entry, or create a space in herdr.</p>
          )}
        </div>

        <div className="shrink-0 w-[150px]">
          <label className="block text-xs text-muted-foreground mb-1">Model</label>
          <select
            className="w-full bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm"
            value={spawnModel}
            onChange={(e) => { setSpawnModel(e.target.value); }}
          >
            <option value="">default</option>
            <option value="sonnet">sonnet</option>
            <option value="opus">opus</option>
            <option value="fable">fable</option>
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Into an existing herdr space, or a new one from a repo in <span className="text-foreground/80 font-mono">environments.json</span>.</p>

      {/* (Task 14 inserts Start command here) */}

      <div className="border-t border-border my-3" />

      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" className="accent-success mt-0.5"
          checked={spawnRemoteControl}
          onChange={(e) => { setSpawnRemoteControl(e.target.checked); }} />
        <span>
          <span className="block text-sm text-foreground font-semibold">Remote Control</span>
          <span className="block text-xs text-muted-foreground">Connects this session outward to claude.ai, so it's reachable from a phone.</span>
        </span>
      </label>

      {spawnError !== null && (
        <p className="text-xs text-destructive whitespace-pre-wrap mt-3">{spawnError}</p>
      )}

      <div className="flex justify-end mt-3">
        <button onClick={() => { void handleSpawn(); }} disabled={spawning || !canSpawn}
          className="shrink-0 px-3 py-2 h-[38px] bg-success text-success-foreground text-sm rounded hover:bg-success/90 disabled:opacity-50">
          {spawning ? "Spawning…" : "Spawn"}
        </button>
      </div>
    </div>
  );
}
