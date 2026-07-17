import type { HerdrEnv } from "../environments.ts";

// SEC-4: with buildAttachSpec's `--` guard dropped (herdr 0.7.1 rejects `attach -- <paneId>`), the
// alnum-leading anchor is now the PRIMARY option-injection defense — a leading-`-` paneId must never
// reach `agent attach`, where it would be read as a flag (routes use execFile arg-arrays, so shell
// injection is already impossible; option injection is the residual risk). Task 0 confirmed real herdr
// pane ids/labels are alphanumeric-leading (`w<hash>:p<n>`), so tightening rejects no valid target.
// This is the single source of truth for the shared regex; api.ts's /read + DELETE routes import it.
export const PANE_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

const ATTACH_RE = /^\/api\/sessions\/([^/]+)\/([^/]+)\/attach$/;

export type UpgradeCheck =
  | { readonly ok: true; readonly env: HerdrEnv; readonly paneId: string }
  | { readonly ok: false; readonly status: number; readonly reason: string };

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null; // malformed %-escape in an untrusted upgrade URL → fail closed
  }
}

/**
 * Pure validation for a WS attach upgrade. Runs OUTSIDE Hono middleware (the raw `server.on('upgrade')`
 * sees none of the route guards), so every check is re-done here. Order (§3.4 step 3): attach-path
 * shape (404) → Origin allowlist (403, fail closed — SEC-1) → env allowlist (400) → PANE_RE (400).
 * Origin is checked before env/pane so a cross-origin probe learns nothing about which envs exist.
 */
export function validateUpgrade(
  url: string,
  headers: { readonly origin?: string | undefined },
  envs: readonly HerdrEnv[],
  allowedOrigins: readonly string[],
): UpgradeCheck {
  const pathOnly = url.split("?")[0] ?? "";
  const m = ATTACH_RE.exec(pathOnly);
  if (m === null) return { ok: false, status: 404, reason: "not an attach path" };

  const origin = headers.origin;
  if (origin === undefined || !allowedOrigins.includes(origin)) {
    return { ok: false, status: 403, reason: "origin not allowed" }; // fail closed (SEC-1)
  }

  const envId = safeDecode(m[1] ?? "");
  const paneId = safeDecode(m[2] ?? "");
  if (envId === null || paneId === null) return { ok: false, status: 400, reason: "malformed path" };

  const env = envs.find((e) => e.id === envId);
  if (env === undefined) return { ok: false, status: 400, reason: "unknown env" };
  if (!PANE_RE.test(paneId)) return { ok: false, status: 400, reason: "bad paneId" };

  return { ok: true, env, paneId };
}

/**
 * Token-bucket rate limit + concurrent cap (SEC-2). `tryReserve()` reserves a slot SYNCHRONOUSLY —
 * `active`/`inWindow` are incremented before the check returns, on the same tick, so two racing
 * upgrades can't both pass the cap before either has spawned. Every teardown path in the caller MUST
 * call `release()` exactly once (clean close, ws error, spawn failure, immediate exit) or slots leak
 * → operator self-DoS. `now` is injected for deterministic tests.
 */
export function createSpawnLimiter(opts: {
  maxConcurrent: number;
  ratePerWindow: number;
  windowMs: number;
  now: () => number;
}): { tryReserve: () => boolean; release: () => void } {
  let active = 0;
  let windowStart = opts.now();
  let inWindow = 0;
  return {
    tryReserve() {
      const t = opts.now();
      if (t - windowStart >= opts.windowMs) {
        windowStart = t;
        inWindow = 0;
      }
      if (active >= opts.maxConcurrent) return false;
      if (inWindow >= opts.ratePerWindow) return false;
      active += 1; // synchronous reservation — before any await in the caller (SEC-2 TOCTOU)
      inWindow += 1;
      return true;
    },
    release() {
      if (active > 0) active -= 1; // clamp: an over-release must not manufacture a free slot
    },
  };
}
