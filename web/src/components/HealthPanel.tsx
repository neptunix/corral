import type { Check, DiagnosticsSnapshot } from "@shared/diagnostics-schema";
import { computeRollup } from "@shared/diagnostics-schema";
import { useState, type JSX } from "react";

import { api } from "../lib/api";
import type { CheckGroup } from "../lib/diagnostics-view";
import { groupChecks, headerStatus, maxCheckedAt, renderedChecks } from "../lib/diagnostics-view";
import { relativeTime } from "../lib/time";

// corral does not serve README.md, so a relative link is dead. The anchors are guarded by
// test/diagnostics-anchors.test.ts against the README in this checkout; the sections these point at
// reach `main` only when PR 1 of the stack merges.
const README = "https://github.com/neptunix/corral/blob/main/README.md";

// No `checking` member on purpose: the status line is suppressed in that state, and leaving the key
// out makes the compiler enforce it rather than a code reviewer.
const STATUS_WORD = { ok: "OK", info: "Recommendations", warning: "Problems", fatal: "Problems" } as const;

const MARK = { fatal: "✗", warning: "⚠", info: "i" } as const;
const STRIPE = {
  fatal: "border-l-2 border-red-500",
  warning: "border-l-2 border-amber-500",
  info: "border-l-2 border-sky-500",
} as const;

/**
 * Operator-facing copy for the two reachable failures. `Error.message` is "HTTP 503" or "Failed to
 * fetch" — a code and a browser string, neither of which says what happened or what to do.
 */
function refreshMessage(err: unknown, streamDown: boolean): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (streamDown || raw === "Failed to fetch") return "corral isn't answering — the page will reconnect on its own.";
  if (raw === "HTTP 503") return "diagnostics aren't enabled on this server.";
  return `Recheck failed: ${raw}`;
}

function Row({ check }: { readonly check: Check }): JSX.Element {
  const { doc } = check;
  return (
    <li className={`pl-2 py-1 ${STRIPE[check.severity]}`}>
      <div className="flex gap-2 items-baseline">
        <span aria-hidden className="text-xs">{MARK[check.severity]}</span>
        {/* title first: the remote jq row carries detail:"" and would otherwise render blank */}
        <span className="text-sm text-foreground">{check.title}</span>
      </div>
      {check.detail !== "" && <p className="text-xs text-muted-foreground pl-5">{check.detail}</p>}
      {doc !== null && (
        <a className="text-xs text-primary hover:underline pl-5" href={`${README}#${doc.anchor}`}
           target="_blank" rel="noopener noreferrer">{doc.title}</a>
      )}
    </li>
  );
}

function Fold({ group }: { readonly group: CheckGroup }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const folded = [...group.ok, ...group.na, ...group.pending];
  if (folded.length === 0) return null;
  // Each half is omitted at zero so a green ✓ never stands over a fold with no passing checks.
  const parts = [
    group.ok.length > 0 ? `✓ ${String(group.ok.length)} OK` : null,
    group.na.length > 0 ? `— ${String(group.na.length)} n/a` : null,
    group.pending.length > 0 ? `… ${String(group.pending.length)} pending` : null,
  ].filter((p) => p !== null);
  const id = `fold-${group.key}`;
  return (
    <>
      <button type="button" onClick={() => { setOpen(!open); }} aria-expanded={open} aria-controls={id}
              className="text-xs text-muted-foreground hover:text-foreground text-left w-full py-1">
        {group.label}: {parts.join(" · ")}
      </button>
      {open && (
        <ul id={id} className="pl-2">
          {folded.map((c) => (
            <li key={c.key} className="text-xs text-muted-foreground py-0.5">{c.title}</li>
          ))}
        </ul>
      )}
    </>
  );
}

interface Props {
  readonly snapshot: DiagnosticsSnapshot;
  readonly streamDown: boolean;
  readonly labelFor: (envId: string) => string;
  readonly onClose: () => void;
  readonly onSnapshot: (s: DiagnosticsSnapshot) => void;
}

export function HealthPanel({ snapshot, streamDown, labelFor, onClose, onSnapshot }: Props): JSX.Element {
  const rows = renderedChecks(snapshot, streamDown);
  const rollup = computeRollup(rows);
  const status = headerStatus(rollup, snapshot.answered.length, rows.length);
  const checkedAt = maxCheckedAt(snapshot.checks);
  const groups = groupChecks(rows, labelFor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { latest, releaseUrl, version } = snapshot.self;

  const recheck = (): void => {
    setBusy(true);
    setError(null);
    api.diagnostics.refresh()
      .then(onSnapshot)
      .catch((err: unknown) => { setError(refreshMessage(err, streamDown)); })
      .finally(() => { setBusy(false); });
  };

  return (
    <aside id="health-panel" className="shrink-0 w-80 border-l border-border flex flex-col overflow-hidden bg-card">
      <div className="px-3 py-2 border-b border-border flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground text-sm font-semibold">Health</span>
          <span className="text-xs text-muted-foreground">
            corral {version ?? "—"} · {checkedAt === null ? "never checked" : relativeTime(checkedAt)}
          </span>
          <button type="button" onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground text-sm"
                  title="Collapse">⇥</button>
        </div>
        <div className="flex items-center gap-2">
          {status !== "checking" && (
            <span className="text-xs text-foreground">
              {STATUS_WORD[status]}
              {/* Reason-free on purpose: pending now only ever means "not asked yet"
                  (first sweep in flight, or a class that has not run). */}
              {rollup.pending > 0 && ` · ${String(rollup.pending)} pending`}
            </span>
          )}
          <button type="button" onClick={recheck} disabled={busy}
                  className="ml-auto text-xs text-primary hover:underline disabled:text-muted-foreground">
            {busy ? "Rechecking…" : "Recheck"}
          </button>
        </div>
        {error !== null && <p className="text-xs text-red-500">{error}</p>}
        {latest !== null && (
          <p className="text-xs text-muted-foreground">
            Update available:{" "}
            {releaseUrl === null
              ? <span className="text-foreground">{latest}</span>
              : <a className="text-primary hover:underline" href={releaseUrl} target="_blank"
                   rel="noopener noreferrer">{latest}</a>}
            {" "}— see the README's Upgrading section.
          </p>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
        {status === "checking" ? (
          <p className="text-xs text-muted-foreground text-center mt-4">
            Waiting for the first sweep — or run one now with Recheck above.
          </p>
        ) : groups.map((g) => (
          <section key={g.key}>
            {g.problems.length > 0 && (
              <>
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground">{g.label}</h3>
                <ul className="flex flex-col gap-1 mt-1">
                  {g.problems.map((c) => <Row key={c.key} check={c} />)}
                </ul>
              </>
            )}
            <Fold group={g} />
          </section>
        ))}
      </div>
    </aside>
  );
}
