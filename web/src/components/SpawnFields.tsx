import type { JSX } from "react";

import type { SpawnForm } from "../lib/use-spawn-form";
import { SPAWN_MODELS } from "../lib/use-spawn-form";

interface Props {
  readonly form: SpawnForm;
  readonly hasSessions: boolean;
}

const REMOTE_CONTROL_HINT = "Connects this session outward to claude.ai, so it's reachable from a phone.";

/**
 * The spawn form's fields only. The submit button lives in TaskEditModal's footer — see useSpawnForm.
 */
export function SpawnFields({ form, hasSessions }: Props): JSX.Element {
  // Only the selected-preset branch can be long (up to 2000 chars, newlines and all) — the other
  // three are fixed single-line strings, so only this one needs clamping + a hover title.
  const startCommandHint: JSX.Element = !form.commandAllowed
    ? <p className="text-xs text-muted-foreground mt-1">Start commands are available for local environments only — your pick is kept.</p>
    : form.presets.length === 0
      ? <p className="text-xs text-muted-foreground mt-1">No start commands on this board — add them in Board settings → Start commands.</p>
      : form.selectedPreset === null
        ? <p className="text-xs text-muted-foreground mt-1">Edited in Board settings → Start commands.</p>
        : (
          <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap line-clamp-3" title={form.selectedPreset.text}>
            {form.selectedPreset.text} — edited in Board settings → Start commands.
          </p>
        );

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-3">
        {hasSessions
          ? "This card already has a session — this starts another one and links it too."
          : "Starts a Claude session and links it to this card."}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2.5">
        <div className="min-w-0">
          <label className="block text-xs text-muted-foreground mb-1">Environment</label>
          <select
            className="w-full bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm"
            value={form.env}
            onChange={(e) => { form.chooseEnv(e.target.value); }}
          >
            {form.envs.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </div>

        <div className="min-w-0">
          <label className="block text-xs text-muted-foreground mb-1">Where it runs</label>
          <select
            // The explicit text/background colors override the browser's own greyed-out disabled
            // rendering, so an off control needs the dimming spelled out (AssignToTaskModal.tsx:52).
            className="w-full bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            value={form.target}
            onChange={(e) => { form.chooseTarget(e.target.value); }}
            disabled={form.targets.phase !== "ready" || form.noTargets}
          >
            {form.spaces.length > 0 && (
              <optgroup label="Existing spaces (join)">
                {form.spaces.map((s) => <option key={s.workspaceId} value={s.workspaceId}>{s.label}</option>)}
              </optgroup>
            )}
            {form.newRepoOptions.length > 0 && (
              <optgroup label="New space from repo">
                {form.newRepoOptions.map((r) => <option key={r.name} value={`new:${r.name}`}>＋ {r.name}</option>)}
              </optgroup>
            )}
          </select>
          {form.targets.phase === "loading" && (
            <p className="text-xs text-muted-foreground mt-1">Loading targets…</p>
          )}
          {form.targets.phase === "error" && (
            <p className="text-xs text-destructive mt-1">Could not load spawn targets — {form.targets.message}</p>
          )}
          {!form.envReachable && (
            <p className="text-xs text-destructive mt-1">corral cannot reach this environment right now, so its spaces are not listed.</p>
          )}
          {form.noTargets && form.envReachable && (
            <p className="text-xs text-muted-foreground mt-1">No spaces or configured repos for this env — add repos to its <span className="font-mono">environments.json</span> entry, or create a space in herdr.</p>
          )}
        </div>

        <div className="min-w-0">
          <label className="block text-xs text-muted-foreground mb-1">Model</label>
          <select
            className="w-full bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm"
            value={form.model}
            onChange={(e) => { form.chooseModel(e.target.value); }}
          >
            {/* Rendered from the same constant the remembered pick is validated against — two hand-kept
                lists drift, and then a model you can select is one that never gets remembered. */}
            {SPAWN_MODELS.map((m) => <option key={m} value={m}>{m === "" ? "default" : m}</option>)}
          </select>
        </div>

        <div className="min-w-0">
          <label className="block text-xs text-muted-foreground mb-1">Start command</label>
          <select
            className="w-full bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            // Bound to the RESOLVED preset, not the raw presetId, so the bound value is always one of the
            // options below. Belt-and-braces, NOT a rendering fix: react-dom selects the first
            // non-disabled option when a controlled value matches none, so a stale id would display as
            // "no command" either way, and both the hint and submit() already read `selectedPreset`.
            // What keeps the three surfaces honest is that single source — and that "no command" stays
            // the FIRST option, since react-dom's fallback is positional (test/spawn-form.test.tsx).
            value={form.selectedPreset?.id ?? ""}
            disabled={!form.commandAllowed}
            onChange={(e) => { form.choosePreset(e.target.value === "" ? null : e.target.value); }}
          >
            <option value="">no command</option>
            {form.presets.map((p) => (
              // First line only, ellipsized by the select's own width; the FULL text is the title —
              // a preset may hold 2000 characters and the default is pre-selected, so the ordinary
              // flow is one click on text the operator has not read to the end.
              <option key={p.id} value={p.id} title={p.text}>{p.text.split("\n")[0] ?? ""}</option>
            ))}
          </select>
          {startCommandHint}
        </div>
      </div>

      <p className="text-xs text-muted-foreground mt-3">Into an existing herdr space, or a new one from a repo in <span className="text-foreground/80 font-mono">environments.json</span>.</p>

      {/* The hint stays VISIBLE, not a hover title: a `title` never fires on touch, and a phone is the
          whole reason this toggle exists. */}
      <label className="flex items-start gap-2 cursor-pointer mt-3">
        <input type="checkbox" className="accent-success mt-0.5"
          checked={form.remoteControl}
          onChange={(e) => { form.setRemoteControl(e.target.checked); }} />
        <span>
          <span className="block text-sm text-foreground">Remote Control</span>
          <span className="block text-xs text-muted-foreground">{REMOTE_CONTROL_HINT}</span>
        </span>
      </label>
    </div>
  );
}
