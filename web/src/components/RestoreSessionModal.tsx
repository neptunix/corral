import type { JSX } from "react";
import { useEffect } from "react";

import { relativeTime } from "../lib/time";

interface Props {
  readonly name: string;
  readonly sessionId: string | null; // non-empty ⟺ resumable; shown as a manual --resume hint
  readonly lastActive: number | null; // transcript-derived; null while loading or unknown
  readonly resumable: boolean;
  readonly onRestore: () => void; // runs the existing resume flow (claude --resume) + auto-open
  readonly onClose: () => void;
}

// Shown when a DETACHED session row is clicked, instead of attaching to the dead pane (that path
// printed `agent target <pane> not found`). Confirms a `claude --resume` when the session id is
// known; otherwise explains why it can't be restored.
export function RestoreSessionModal({ name, sessionId, lastActive, resumable, onRestore, onClose }: Props): JSX.Element {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const when = lastActive !== null ? relativeTime(lastActive) : "recently";

  return (
    // Rendered from inside the draggable TaskCard: stop pointerdown (else a drag starts) and click (else
    // it bubbles to the card's open handler) at the overlay before they reach the card.
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onPointerDown={(e) => { e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <div className="bg-card border border-border rounded-lg p-6 w-[420px] max-w-[90vw]" onClick={(e) => { e.stopPropagation(); }}>
        <h2 className="text-foreground font-semibold mb-1">Session ended</h2>
        <p className="text-sm text-muted-foreground mb-4">
          <span className="text-foreground/90">{name}</span> ended {when}.
          {resumable && " Restore it into the same Claude session?"}
        </p>

        {resumable ? (
          <>
            {sessionId !== null && sessionId !== "" && (
              <p className="text-xs text-muted-foreground/70 font-mono mb-4 break-all">claude --resume {sessionId}</p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose}
                className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
              <button type="button" onClick={() => { onRestore(); onClose(); }}
                className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90">Restore</button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-4">
              No Claude session id was recorded for this session, so it can&apos;t be restored.
            </p>
            <div className="flex justify-end">
              <button type="button" onClick={onClose}
                className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90">Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
