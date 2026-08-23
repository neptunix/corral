import { useEffect, useState, type JSX } from "react";

import { TONE_DOT, type SessionStateTone } from "../lib/session-state";

export interface CardSessionOffer {
  readonly env: string;
  readonly paneId: string;
  readonly sessionId: string | null;
  readonly name: string;
  readonly tone: SessionStateTone;
  readonly label: string;
}

interface Props {
  readonly taskTitle: string;
  readonly columnLabel: string;
  readonly sessions: readonly CardSessionOffer[];
  readonly onMove: () => Promise<void>;    // writes the status; nothing has moved before this runs
  readonly onCloseOne: (session: CardSessionOffer) => Promise<void>;
  readonly onDismiss: () => void;          // cancel: no move, no close
}

// Asked BEFORE the card moves into a closed column, when sessions on it are still live. Nothing has
// been written when this opens, so the ✕ (and Escape, and the backdrop) cancel the whole thing — the
// card stays where it was. That is why there are three outcomes rather than two: moving the card and
// closing its sessions are separate decisions, and only the destructive button takes both.
//
// The heading is the question; the card title rides above as one truncated line, because the board
// behind the dialog is what identifies it. Each row carries the dot and the env·pane that say WHICH
// session — the two things that decide whether closing it is safe.
export function CloseCardSessionsModal({ taskTitle, columnLabel, sessions, onMove, onCloseOne, onDismiss }: Props): JSX.Element {
  // Shrinks to the ones still open. A close is a pane kill and cannot be undone or repeated: retrying
  // the whole list would re-send the successes, and the server answers a dead pane with 404 — so the
  // first retry would fail on an already-closed row and never reach the one still running.
  const [remaining, setRemaining] = useState<readonly CardSessionOffer[]>(sessions);
  // Keyed by env:paneId, not by name: a card can hold same-named sessions in different environments
  // (names are only kept unique within one), and keying on the name would collapse two failures into
  // one row — hiding a session that is still running behind one that is.
  const [failures, setFailures] = useState<readonly { readonly id: string; readonly name: string; readonly message: string }[]>([]);
  // The move is written once. A retry after a partial close must not re-send it, and must not be
  // cancellable either — by then the card really has moved, whatever happens to the rest.
  const [moved, setMoved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape" && !busy && !moved) onDismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [busy, moved, onDismiss]);

  async function move(): Promise<boolean> {
    if (moved) return true;
    try {
      await onMove();
      setMoved(true);
      return true;
    } catch (err) {
      setFailures([{ id: "move", name: columnLabel, message: err instanceof Error ? err.message : String(err) }]);
      return false;
    }
  }

  async function run(closeSessions: boolean): Promise<void> {
    setBusy(true);
    setFailures([]);
    // The move goes first and a failed one stops here: closing the sessions of a card that never
    // moved is the one outcome nobody asked for.
    if (!await move()) { setBusy(false); return; }
    if (!closeSessions) { setBusy(false); onDismiss(); return; }

    const failed: { id: string; name: string; message: string }[] = [];
    const stillOpen: CardSessionOffer[] = [];
    // Every session gets its attempt — one unreachable host must not shield the rest from closing.
    for (const s of remaining) {
      try {
        await onCloseOne(s);
      } catch (err) {
        failed.push({ id: `${s.env}:${s.paneId}`, name: s.name, message: err instanceof Error ? err.message : String(err) });
        stillOpen.push(s);
      }
    }
    setBusy(false);
    if (stillOpen.length === 0) { onDismiss(); return; }
    setRemaining(stillOpen);
    setFailures(failed);
  }

  const n = remaining.length;
  const sessionCount = n === 1 ? "1 session" : `${String(n)} sessions`;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      onPointerDown={(e) => { e.stopPropagation(); }}
      onClick={() => { if (!busy && !moved) onDismiss(); }}
    >
      <div className="bg-card border border-border rounded-lg w-full max-w-md p-4" onClick={(e) => { e.stopPropagation(); }}>
        <div className="flex items-center justify-between gap-3 mb-2.5">
          <span className="min-w-0 truncate text-[11px] text-muted-foreground/85" title={taskTitle}>{taskTitle}</span>
          <button
            type="button"
            aria-label="Cancel the move"
            onClick={onDismiss}
            disabled={busy || moved}
            className="shrink-0 -mr-1 flex items-center justify-center w-[22px] h-[22px] rounded text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6 L18 18 M18 6 L6 18" />
            </svg>
          </button>
        </div>

        <h2 className="text-foreground text-[15px] font-semibold mb-1">
          {moved ? `Moved to ${columnLabel}` : `Move to ${columnLabel}?`}
        </h2>
        <p className="text-muted-foreground text-sm mb-3">
          {sessionCount} on this card {n === 1 ? "is" : "are"} still running.
        </p>

        <ul className="border border-border rounded-md overflow-hidden mb-3.5 max-h-52 overflow-y-auto">
          {remaining.map((s) => (
            <li key={`${s.env}:${s.paneId}`} className="flex items-center justify-between gap-3 px-2.5 py-2 border-b border-border/70 last:border-b-0">
              <span className="min-w-0 flex items-center gap-2">
                {/* The dot's colour is not on its own enough to act on: `idle` and `unknown` share
                    one, and "at rest" is not "corral cannot say". The word settles it. */}
                <span className={`shrink-0 w-2 h-2 rounded-full ${TONE_DOT[s.tone]}`} title={s.label} />
                <span className="truncate font-mono text-xs text-foreground" title={s.name}>{s.name}</span>
              </span>
              {/* State before location: the pane id identifies nothing to a human, so it rides in the
                  tooltip and the two things that decide whether this kill is safe get the width. */}
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/80" title={`${s.env} · ${s.paneId}`}>
                {s.label} · {s.env}
              </span>
            </li>
          ))}
        </ul>

        {failures.length > 0 && (
          <div className="text-[11px] text-red-400 border border-red-400/40 rounded p-2 mb-3">
            {failures.map((f) => <div key={f.id} className="truncate" title={f.message}>{f.name}: {f.message}</div>)}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy || moved}
            className="-ml-1.5 px-1.5 py-1 text-xs rounded text-muted-foreground hover:text-foreground disabled:opacity-50"
          >Cancel</button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { void run(false); }}
              disabled={busy}
              className="px-2 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
            >{moved ? "Leave them running" : "Move only"}</button>
            <button
              type="button"
              onClick={() => { void run(true); }}
              disabled={busy}
              className="px-2.5 py-1.5 text-xs rounded bg-destructive text-destructive-foreground hover:opacity-90 disabled:opacity-50"
            >{busy ? "Working…" : moved ? `Close ${sessionCount}` : `Move and close ${sessionCount}`}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
