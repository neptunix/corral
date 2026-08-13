import type { SessionLink, SpawnPreset } from "@shared/board-schema";
import { useEffect, useMemo, useState } from "react";

import type { SpawnRequestBody } from "./api";
import { api } from "./api";
import { readSpawnPrefs, rememberSpawnEnv, rememberSpawnModel, rememberSpawnRemoteControl, rememberSpawnTarget } from "./spawn-prefs";
import { buildSpawnRequest } from "./spawn-request";

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
  | { readonly phase: "ready"; readonly spaces: readonly Space[]; readonly repos: readonly Repo[] };

interface Space { readonly workspaceId: string; readonly label: string }
interface Repo { readonly name: string }

// A configured repo that already has a same-named space isn't offered as "new" — you'd join instead.
// One definition, used both for the rendered options and for validating a remembered pick: two copies
// of this rule can drift, and then the effect below selects a target the picker never offered.
function newRepos(spaces: readonly Space[], repos: readonly Repo[]): readonly Repo[] {
  const labels = new Set(spaces.map((s) => s.label.toLowerCase()));
  return repos.filter((r) => !labels.has(r.name.toLowerCase()));
}

// "" is the picker's "default" — no model field is sent, so the session inherits the last-used one.
export const SPAWN_MODELS = ["", "sonnet", "opus", "fable"] as const;

interface Args {
  readonly envs: readonly SpawnEnvOption[];
  readonly presets: readonly SpawnPreset[];
  readonly defaultPresetId: string | null;
  readonly onSpawn: (body: SpawnRequestBody) => Promise<SessionLink>;
  readonly onSpawned: (link: SessionLink) => void; // the modal closes + auto-attaches
}

export interface SpawnForm {
  readonly envs: readonly SpawnEnvOption[];
  readonly presets: readonly SpawnPreset[];
  readonly env: string;
  readonly chooseEnv: (id: string) => void;
  readonly targets: TargetsState;
  readonly spaces: readonly Space[];
  readonly newRepoOptions: readonly Repo[];
  readonly noTargets: boolean;
  readonly envReachable: boolean;
  readonly commandAllowed: boolean;
  readonly target: string;
  readonly chooseTarget: (value: string) => void;
  readonly model: string;
  readonly chooseModel: (model: string) => void;
  readonly selectedPreset: SpawnPreset | null;
  readonly choosePreset: (id: string | null) => void;
  readonly remoteControl: boolean;
  readonly setRemoteControl: (on: boolean) => void;
  readonly canSpawn: boolean;
  readonly spawning: boolean;
  readonly error: string | null;
  readonly submit: () => Promise<void>;
}

/**
 * All spawn-form state, split out from the rendered fields so the SUBMIT BUTTON can live somewhere
 * else entirely — TaskEditModal keeps it in the modal footer, where it is always on screen and can
 * never be mistaken for Save.
 */
export function useSpawnForm({ envs, presets, defaultPresetId, onSpawn, onSpawned }: Args): SpawnForm {
  // Read once per mount. Only an EXPLICIT pick writes back (below), so a fallback applied because a
  // remembered env or space is momentarily gone never clobbers the memory.
  const prefs = useMemo(() => readSpawnPrefs(), []);

  const [spawning, setSpawning] = useState(false);
  const [spawnEnv, setSpawnEnv] = useState(() => {
    const remembered = prefs.env;
    return remembered !== null && envs.some((e) => e.id === remembered) ? remembered : envs[0]?.id ?? "";
  });
  const [spawnModel, setSpawnModel] = useState(() => {
    const remembered = prefs.model;
    return remembered !== null && SPAWN_MODELS.some((m) => m === remembered) ? remembered : "";
  });
  // Restored from the last spawn at the operator's request — see the deviation note in spawn-prefs.ts.
  const [spawnRemoteControl, setSpawnRemoteControl] = useState(prefs.remoteControl);
  // Seeded from the remembered picks, then owned by this session: chooseTarget updates it, so a target
  // picked by hand survives switching env away and back. Reading the mount-time snapshot instead lost
  // that pick, because only localStorage was written.
  const [targetByEnv, setTargetByEnv] = useState<Record<string, string>>(prefs.targetByEnv);
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
  const newRepoOptions = newRepos(ready?.spaces ?? [], ready?.repos ?? []);
  // "Empty" is a READY state, never a loading one — that distinction is the point of this task.
  const noTargets = ready !== null && ready.spaces.length === 0 && newRepoOptions.length === 0;

  // Default the picker to the remembered target for THIS env if it is still offered, else the first
  // available one — an existing space, else a new-from-repo. Validating against the freshly fetched
  // list is what keeps a deleted space from being pre-selected on a control that looks correctly filled.
  useEffect(() => {
    if (targets.phase !== "ready") { setSelectedTarget(""); return; }
    const offered = [
      ...targets.spaces.map((s) => s.workspaceId),
      ...newRepos(targets.spaces, targets.repos).map((r) => `new:${r.name}`),
    ];
    const remembered = targetByEnv[spawnEnv];
    if (remembered !== undefined && offered.includes(remembered)) { setSelectedTarget(remembered); return; }
    setSelectedTarget(offered[0] ?? "");
  }, [targets, spawnEnv, targetByEnv]);

  const canSpawn = targets.phase === "ready" && spawnEnv !== "" && selectedTarget !== "";

  function chooseEnv(id: string): void {
    setSpawnEnv(id);
    rememberSpawnEnv(id);
  }

  function chooseTarget(value: string): void {
    setSelectedTarget(value);
    setTargetByEnv((prev) => ({ ...prev, [spawnEnv]: value }));
    rememberSpawnTarget(spawnEnv, value);
  }

  function chooseModel(model: string): void {
    setSpawnModel(model);
    rememberSpawnModel(model);
  }

  function chooseRemoteControl(on: boolean): void {
    setSpawnRemoteControl(on);
    rememberSpawnRemoteControl(on);
  }

  async function submit(): Promise<void> {
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

  return {
    envs,
    presets,
    env: spawnEnv,
    chooseEnv,
    targets,
    spaces: ready?.spaces ?? [],
    newRepoOptions,
    noTargets,
    envReachable,
    commandAllowed,
    target: selectedTarget,
    chooseTarget,
    model: spawnModel,
    chooseModel,
    selectedPreset,
    choosePreset: setPresetId,
    remoteControl: spawnRemoteControl,
    setRemoteControl: chooseRemoteControl,
    canSpawn,
    spawning,
    error: spawnError,
    submit,
  };
}
