import { z } from "zod";

// The operator's last spawn picks, so reopening a card does not mean re-choosing the same env and
// space every time. localStorage is an untrusted boundary — another tab, an older corral build, or a
// hand-edited value can put anything under this key — so every field is Zod-validated and falls back
// instead of throwing. Nothing here is authoritative: whether a remembered value is still OFFERED is
// re-checked against the live env/target lists by the caller (use-spawn-form.ts).
const KEY = "corral.spawn.prefs";

// The target is keyed BY ENV: a workspaceId (or "new:<repo>") only means anything inside the
// environment it came from, so one flat "last target" would hand env B a space that lives on env A.
const spawnPrefsSchema = z.object({
  env: z.string().nullable().catch(null),
  targetByEnv: z.record(z.string()).catch({}),
  model: z.string().nullable().catch(null),
  // Remembered at the operator's explicit request. This DEVIATES from the original design's A.1 rule
  // ("remoteControl is opt-in per spawn, corral never enables it implicitly") — a restored tick means
  // the next session connects outward to claude.ai without a fresh decision. What still guards it: the
  // checkbox is always visible on the Run Claude tab with its restored state, and a resume never sends
  // the flag at all (A.4), so this only ever affects a spawn the operator is looking at.
  remoteControl: z.boolean().catch(false),
});

type SpawnPrefs = z.infer<typeof spawnPrefsSchema>;

function empty(): SpawnPrefs {
  return { env: null, targetByEnv: {}, model: null, remoteControl: false };
}

export function readSpawnPrefs(): SpawnPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return empty();
    const parsed = spawnPrefsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : empty();
  } catch {
    // Bad JSON, or a browser that denies storage access (private mode). Prefs are a convenience —
    // never a reason to break the spawn form.
    return empty();
  }
}

function write(next: SpawnPrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota or denied storage — dropping the memory is the correct degradation.
  }
}

export function rememberSpawnEnv(env: string): void {
  write({ ...readSpawnPrefs(), env });
}

export function rememberSpawnModel(model: string): void {
  write({ ...readSpawnPrefs(), model });
}

export function rememberSpawnTarget(env: string, target: string): void {
  const prefs = readSpawnPrefs();
  write({ ...prefs, targetByEnv: { ...prefs.targetByEnv, [env]: target } });
}

export function rememberSpawnRemoteControl(on: boolean): void {
  write({ ...readSpawnPrefs(), remoteControl: on });
}
