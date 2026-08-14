import { FOCUS_TRANSLATION_ENABLED } from "../config.ts";
import type { HerdrEnv } from "../environments.ts";

/**
 * Focus translation: corral gives a pane a real focus-in/focus-out cycle when the operator opens and
 * closes its web terminal, so Claude's own focus state actually changes.
 *
 * WHY this exists: Claude writes its `away_summary` recap only while its terminal focus state is
 * `blurred`, and that state is set exclusively by terminal focus-report sequences. On a host terminal
 * that reports no focus, herdr is their only producer — so when the operator stopped switching herdr
 * tabs in favour of the corral board, nothing was ever blurred again and the recap source went silent.
 * corral had de-energized its own source; this restores it without writing a single byte into the pane.
 *
 * The RESTORE is what makes it acceptable to run on every open: the previously focused tab is focused
 * again on close, so the operator's own herdr view ends exactly where it started, while the pane has
 * been through focus-in and focus-out and is now `blurred`.
 *
 * Everything here is best-effort and fire-and-forget: a herdr that is slow, missing or refusing must
 * never delay or break the operator's terminal, which is why no caller awaits these.
 */
export interface FocusOps {
  readonly focusedTabId: (env: HerdrEnv) => Promise<string | null>;
  readonly tabIdOfPane: (env: HerdrEnv, paneId: string) => Promise<string>;
  readonly tabFocus: (env: HerdrEnv, tabId: string) => Promise<void>;
}

export interface FocusTranslator {
  /** Save the currently focused tab, then focus this pane's tab. */
  onAttachOpen(env: HerdrEnv, paneId: string): void;
  /** Restore the tab saved at open — which blurs this pane. */
  onAttachClose(env: HerdrEnv, paneId: string): void;
}

export function createFocusTranslator(
  ops: FocusOps,
  opts?: { readonly enabled?: boolean; readonly onError?: (message: string) => void },
): FocusTranslator {
  const enabled = opts?.enabled ?? FOCUS_TRANSLATION_ENABLED;
  const onError = opts?.onError ?? ((m: string): void => { console.warn(`[focus] ${m}`); });
  // Tab focused at attach-open time, per `env:paneId`. Absent = this pane has no attach in flight.
  const saved = new Map<string, string | null>();
  // Per-pane operation chain. Open does two herdr round-trips; without serialization a fast
  // open→close would let the restore run BEFORE the focus it is meant to undo, inverting the cycle and
  // leaving the pane focused — the one state that produces no recap.
  const chains = new Map<string, Promise<void>>();

  function enqueue(key: string, op: () => Promise<void>): void {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(op).catch((err: unknown) => {
      onError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      // Drop the chain once it has drained, so an idle pane holds no promise. Guarded by identity: a
      // newer op may already have chained onto this one.
      if (chains.get(key) === next) chains.delete(key);
    });
    chains.set(key, next);
  }

  return {
    onAttachOpen(env, paneId) {
      if (!enabled) return;
      const key = `${env.id}:${paneId}`;
      enqueue(key, async () => {
        const previous = await ops.focusedTabId(env);
        const target = await ops.tabIdOfPane(env, paneId);
        saved.set(key, previous);
        await ops.tabFocus(env, target);
      });
    },

    onAttachClose(env, paneId) {
      if (!enabled) return;
      const key = `${env.id}:${paneId}`;
      enqueue(key, async () => {
        const previous = saved.get(key);
        saved.delete(key);
        // `undefined` = no open was recorded (translation was off, or the open failed before saving).
        // `null` = herdr reported NO focused tab, so there is nothing to restore to; the pane stays
        // focused until the next focus event elsewhere blurs it. Neither case is an error.
        if (previous === undefined || previous === null) return;
        await ops.tabFocus(env, previous);
      });
    },
  };
}
