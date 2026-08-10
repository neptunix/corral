import type { SessionLink, SpawnPreset } from "@shared/board-schema";
import type { JSX } from "react";
import { useEffect, useState } from "react";

import type { SpawnRequestBody } from "../lib/api";
import { api } from "../lib/api";
import { buildSpawnRequest } from "../lib/spawn-request";

export interface SpawnEnvOption {
  readonly id: string;
  readonly label: string;
  readonly kind: "local" | "remote" | null; // null = unknown → treated as NOT local
  readonly reachable: boolean;
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
  readonly presets: readonly SpawnPreset[];
  readonly defaultPresetId: string | null;
  readonly hasSessions: boolean; // "Spawn another session" vs "Spawn a new session"
  readonly onSpawn: (body: SpawnRequestBody) => Promise<SessionLink>;
  readonly onSpawned: (link: SessionLink) => void; // the modal closes + auto-attaches
}

export function SpawnPanel({ envs, presets, defaultPresetId, hasSessions, onSpawn, onSpawned }: SpawnPanelProps): JSX.Element {
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
  // Deliberately NOT reset when spawnEnv changes — buildSpawnRequest already drops it for a non-local
  // env, so the operator's pick survives switching away and back rather than being lost.
  const [presetId, setPresetId] = useState<string | null>(defaultPresetId);
  const selectedPreset = presets.find((p) => p.id === presetId) ?? null;
  const envKind = envs.find((e) => e.id === spawnEnv)?.kind ?? null;
  const envReachable = envs.find((e) => e.id === spawnEnv)?.reachable ?? true;
  const commandAllowed = envKind === "local";

  // Fetch spawn targets for the chosen env. The targets request itself CATCHES an unreachable env
  // (server/api.ts) and still returns 200 with the configured repos, so "error" phase here means the
  // request itself failed (network/parse), not that the env is down — reachability is a separate
  // signal read from `envs` below. Cleared to "loading" IMMEDIATELY on env change, so a space belonging
  // to the previous env is never briefly selectable and the misconfiguration text cannot render over an
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
      const link = await onSpawn(buildSpawnRequest({
        env: spawnEnv,
        envKind,
        targetWorkspaceId,
        repo: repoArg,
        model: spawnModel === "" ? null : spawnModel,
        remoteControl: spawnRemoteControl,
        startCommand: selectedPreset?.text ?? null,
      }));
      onSpawned(link);
    } catch (err) {
      setSpawnError(err instanceof Error ? err.message : String(err));
    } finally {
      setSpawning(false);
    }
  }

  // Only the selected-preset branch can be long (up to 2000 chars, newlines and all) — the other
  // three are fixed single-line strings, so only this one needs clamping + a hover title.
  const startCommandHint: JSX.Element = !commandAllowed
    ? <p className="text-xs text-muted-foreground mt-1">Start commands are available for local environments only — your pick is kept.</p>
    : presets.length === 0
      ? <p className="text-xs text-muted-foreground mt-1">No start commands on this board — add them in Board settings → Start commands.</p>
      : selectedPreset === null
        ? <p className="text-xs text-muted-foreground mt-1">Edited in Board settings → Start commands.</p>
        : (
          <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap line-clamp-3" title={selectedPreset.text}>
            {selectedPreset.text} — edited in Board settings → Start commands.
          </p>
        );

  return (
    <div className="mb-4 p-3 bg-muted rounded">
      <p className="text-xs text-muted-foreground mb-2">
        {hasSessions ? "Spawn another session" : "Spawn a new session"}
      </p>

      <div className="flex flex-wrap gap-3 mb-1">
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

        <div className="grow basis-[220px] min-w-0">
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
            <p className="text-xs text-destructive mt-1">Could not load spawn targets — {targets.message}</p>
          )}
          {!envReachable && (
            <p className="text-xs text-destructive mt-1">corral cannot reach this environment right now, so its spaces are not listed.</p>
          )}
          {noTargets && envReachable && (
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

      <div className="mt-3">
        <label className="block text-xs text-muted-foreground mb-1">Start command</label>
        <select
          className="w-full bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm"
          value={presetId ?? ""}
          disabled={!commandAllowed}
          onChange={(e) => { setPresetId(e.target.value === "" ? null : e.target.value); }}
        >
          <option value="">no command</option>
          {presets.map((p) => (
            // First line only, ellipsized by the select's own width; the FULL text is the title —
            // a preset may hold 2000 characters and the default is pre-selected, so the ordinary
            // flow is one click on text the operator has not read to the end.
            <option key={p.id} value={p.id} title={p.text}>{p.text.split("\n")[0] ?? ""}</option>
          ))}
        </select>
        {startCommandHint}
      </div>

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
