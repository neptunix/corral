import { useState, type JSX } from "react";

interface Props {
  readonly name: string;
  readonly taskTitle: string;
  readonly env: string;
  readonly paneId: string;
  readonly tabId: string; // EnrichedSessionLink.tabId defaults to "" (never recorded), not undefined
  readonly sessionId: string | null;
  readonly status: string;
  readonly model: string | null;
  readonly ctxPct: string | null;
  readonly onCloseTab: () => Promise<void>;   // primary: herdr tab close
  readonly onClosePane: () => Promise<void>;  // fallback: herdr pane close
  readonly onDismiss: () => void;             // close the modal without acting
}

// Confirm-before-kill dialog for a running session. Primary action closes the herdr tab; on failure it
// keeps the modal open, shows the error, and reveals the pane-close fallback. No window.alert anywhere.
export function CloseSessionModal(props: Props): JSX.Element {
  const { name, taskTitle, env, paneId, tabId, sessionId, status, model, ctxPct } = props;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      props.onDismiss(); // success → the row goes detached on the next poll
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const shortId = sessionId !== null && sessionId !== "" ? sessionId.slice(0, 8) : "—";
  const rows: readonly [string, string][] = [
    ["Task", taskTitle === "" ? "—" : taskTitle],
    ["Env", env],
    ["Pane", paneId],
    ["Tab", tabId !== "" ? tabId : "none recorded"],
    ["Session", shortId],
    ["Status", status],
    ["Model", model ?? "—"],
    ["Context", ctxPct !== null ? `${ctxPct}%` : "—"],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      onClick={props.onDismiss}
    >
      <div className="bg-card border border-border rounded-lg w-full max-w-md p-4" onClick={(e) => { e.stopPropagation(); }}>
        <h2 className="text-foreground text-sm font-semibold mb-1">Close session</h2>
        <p className="text-muted-foreground text-sm mb-3 truncate" title={name}>{name}</p>
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-[11px] mb-3">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground/70">{k}</dt>
              <dd className="text-foreground/90 font-mono truncate" title={v}>{v}</dd>
            </div>
          ))}
        </dl>
        {error !== null && (
          <div className="text-[11px] text-red-400 border border-red-400/40 rounded p-2 mb-3">
            Close failed: {error}
            <div className="text-muted-foreground/70 mt-1">You can close the pane directly instead.</div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onDismiss}
            disabled={busy}
            className="px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
          >Cancel</button>
          {error !== null && (
            <button
              type="button"
              onClick={() => { void run(props.onClosePane); }}
              disabled={busy}
              className="px-2 py-1 text-xs rounded border border-orange-400/60 text-orange-300 hover:border-orange-400 disabled:opacity-50"
            >Close by pane</button>
          )}
          <button
            type="button"
            onClick={() => { void run(props.onCloseTab); }}
            disabled={busy}
            className="px-2 py-1 text-xs rounded bg-destructive text-destructive-foreground hover:opacity-90 disabled:opacity-50"
          >{busy ? "Closing…" : "Close session"}</button>
        </div>
      </div>
    </div>
  );
}
