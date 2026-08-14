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
  /** Focus this pane's tab, remembering the operator's tab if this is the environment's first attach. */
  onAttachOpen(env: HerdrEnv, paneId: string): void;
  /** On the environment's last attach, restore the operator's tab — which blurs the pane. */
  onAttachClose(env: HerdrEnv, paneId: string): void;
}

export function createFocusTranslator(
  ops: FocusOps,
  opts?: { readonly enabled?: boolean; readonly onError?: (message: string) => void },
): FocusTranslator {
  const enabled = opts?.enabled ?? FOCUS_TRANSLATION_ENABLED;
  const onError = opts?.onError ?? ((m: string): void => { console.warn(`[focus] ${m}`); });
  /**
   * State is per ENVIRONMENT, not per pane, because herdr's focus is a single slot per server: one tab
   * is focused, everything else is blurred. Saving a tab per pane got this wrong in both directions —
   * a second attach on the same pane overwrote the saved tab with the pane's own, and two attaches on
   * different panes each restored what *they* displaced, so the first close yanked focus away from a
   * terminal still open and the last one landed on a tab nobody was watching. Either way the operator's
   * real tab was lost and a pane was left focused, which is the one state that yields no recap.
   *
   * So: remember the operator's tab when the attach count for the environment goes 0→1, and restore it
   * only when the count returns to 0. `previous` is null when herdr reported no focused tab at all.
   */
  const state = new Map<string, { readonly count: number; readonly previous: string | null }>();
  /**
   * Operation chain, keyed by environment for the same reason. Open does two herdr round-trips; without
   * serialization a fast open→close would let the restore run BEFORE the focus it is meant to undo,
   * inverting the cycle and leaving the pane focused.
   */
  const chains = new Map<string, Promise<void>>();

  function enqueue(envId: string, op: () => Promise<void>): void {
    const prev = chains.get(envId) ?? Promise.resolve();
    const next = prev.then(op).catch((err: unknown) => {
      onError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      // Drop the chain once it has drained, so an idle environment holds no promise. Guarded by
      // identity: a newer op may already have chained onto this one.
      if (chains.get(envId) === next) chains.delete(envId);
    });
    chains.set(envId, next);
  }

  return {
    onAttachOpen(env, paneId) {
      if (!enabled) return;
      enqueue(env.id, async () => {
        // Resolved BEFORE the count is touched: a failure here must not leave a phantom attach behind,
        // which would suppress the restore for every attach that follows.
        const target = await ops.tabIdOfPane(env, paneId);
        const current = state.get(env.id);
        if (current === undefined) {
          state.set(env.id, { count: 1, previous: await ops.focusedTabId(env) });
        } else {
          state.set(env.id, { count: current.count + 1, previous: current.previous });
        }
        await ops.tabFocus(env, target);
      });
    },

    onAttachClose(env, paneId) {
      if (!enabled) return;
      enqueue(env.id, async () => {
        const current = state.get(env.id);
        // No open was recorded — translation was off when it opened, or the open failed before counting.
        if (current === undefined) return;
        // Another terminal is still open on this environment: it holds the focus, so restoring now would
        // blur a pane the operator is actively watching.
        if (current.count > 1) {
          state.set(env.id, { count: current.count - 1, previous: current.previous });
          return;
        }
        state.delete(env.id);
        if (current.previous === null) {
          // Half a cycle: focus went IN but there is nowhere to send it back to, so the pane stays
          // focused and will not write a recap until something else takes focus. Said out loud rather
          // than swallowed — an unexplained silent recap is the bug this whole feature exists to end.
          onError(`no tab was focused when ${env.id}:${paneId} attached — nothing to restore, its pane stays focused`);
          return;
        }
        await ops.tabFocus(env, current.previous);
      });
    },
  };
}
