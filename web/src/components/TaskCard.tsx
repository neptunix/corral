import { useDraggable } from "@dnd-kit/core";
import type { EnrichedSessionLink, EnrichedTask } from "@shared/board-schema";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { CloseSessionModal } from "./CloseSessionModal";
import { RestoreSessionModal } from "./RestoreSessionModal";
import { api } from "../lib/api";
import { CLOSING_STATUS, RESUMING_STATUS } from "../lib/optimistic";
import { relativeTime } from "../lib/time";

const PRIORITY_STYLE: Record<string, string> = {
  p0: "bg-red-900/60 text-red-300 light:bg-red-100 light:text-red-700",
  p1: "bg-orange-900/60 text-orange-300 light:bg-orange-100 light:text-orange-700",
  p2: "bg-yellow-900/60 text-yellow-300 light:bg-yellow-100 light:text-yellow-800",
  p3: "bg-slate-700 text-slate-300 light:bg-slate-200 light:text-slate-700",
};
const PRIORITY_LABEL: Record<string, string> = { p0: "P0", p1: "P1", p2: "P2", p3: "P3" };
const STATUS_DOT: Record<string, string> = {
  working: "bg-emerald-400 light:bg-emerald-600",
  idle: "bg-slate-500",
  blocked: "bg-red-400 light:bg-red-600",
  done: "bg-sky-400 light:bg-sky-600",
};

interface Props {
  readonly task: EnrichedTask;
  readonly onEdit: () => void;
  readonly onOpenSession: (env: string, paneId: string, awaitAgent?: boolean, title?: string) => void;
  readonly onDetachSession: (env: string, paneId: string, sessionId: string | null) => void;
  readonly onCloseSession: (env: string, paneId: string, sessionId: string | null) => Promise<void>;
  readonly onResumeSession: (env: string, paneId: string, sessionId: string | null) => void;
}

export function TaskCard({ task, onEdit, onOpenSession, onDetachSession, onCloseSession, onResumeSession }: Props): JSX.Element {
  // Opening a session always uses awaitAgent=false (attach once). Retry-until-registered is only for
  // the post-spawn auto-open (TaskEditModal); a manual reopen of a LIVE session attaches immediately,
  // and a manual open of a DEAD one should fail fast with a clear message — not spin "starting…" for
  // 25s against a pane that's gone. The card body opens the PRIMARY session (live-first); each session
  // row opens that specific one; the ⚙ always edits. With no session, the body falls to edit.
  const liveSession = task.sessions.find((s) => s.live !== null && !s.live.detached);
  const primary = liveSession ?? task.sessions[0];
  const handleCardClick = (): void => {
    if (primary !== undefined) onOpenSession(primary.env, primary.paneId, false, task.title);
    else onEdit();
  };
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `task-drag:${task.id}`,
    data: { type: "task", taskId: task.id },
  });

  return (
    <div
      ref={setNodeRef}
      onClick={handleCardClick}
      {...listeners}
      {...attributes}
      className={`bg-card border border-border rounded-lg p-3 cursor-pointer hover:border-primary transition-colors ${isDragging ? "opacity-40" : ""}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-foreground text-sm font-medium leading-snug">{task.title}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          {task.priority !== null && (
            <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${PRIORITY_STYLE[task.priority] ?? ""}`}>
              {PRIORITY_LABEL[task.priority] ?? task.priority}
            </span>
          )}
          <button
            type="button"
            onPointerDown={(e) => { e.stopPropagation(); }}
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="text-muted-foreground hover:text-foreground text-base leading-none p-1 -m-1"
            title="Edit task"
          >⚙</button>
        </div>
      </div>
      {task.sessions.length > 0 && (
        <div className="flex flex-col gap-1 mt-2">
          {task.sessions.map((s) => (
            // Key includes sessionId: after churn-heal two links can share an enriched paneId (one
            // live at the reused pane, one detached still pointing at it), but their sessionIds differ.
            <SessionRow
              key={`${s.env}:${s.paneId}:${s.sessionId ?? ""}`}
              s={s}
              title={task.title}
              onOpenSession={onOpenSession}
              onCloseSession={onCloseSession}
              onResumeSession={onResumeSession}
              onDetachSession={onDetachSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface SessionRowProps {
  readonly s: EnrichedSessionLink;
  readonly title: string;
  readonly onOpenSession: (env: string, paneId: string, awaitAgent?: boolean, title?: string) => void;
  readonly onCloseSession: (env: string, paneId: string, sessionId: string | null) => Promise<void>;
  readonly onResumeSession: (env: string, paneId: string, sessionId: string | null) => void;
  readonly onDetachSession: (env: string, paneId: string, sessionId: string | null) => void;
}

function SessionRow({ s, title, onOpenSession, onCloseSession, onResumeSession, onDetachSession }: SessionRowProps): JSX.Element {
  const detached = s.live?.detached === true;
  // Optimistic transient (App overlays a synthetic live.status during a close/resume round-trip). While
  // pending we suppress every row action + the click behavior so item 1 and item 2 can't fight — e.g. the
  // synthetic "closing" sets detached:true, which would otherwise re-arm Restore on a session being killed.
  const isClosing = s.live?.status === CLOSING_STATUS;
  const pending = isClosing || s.live?.status === RESUMING_STATUS;
  const resumable = detached && !pending && s.sessionId !== null && s.sessionId !== "";
  const [lastActive, setLastActive] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false); // inline Detach/Remove confirm
  const [showRestore, setShowRestore] = useState(false);
  const [showClose, setShowClose] = useState(false);

  useEffect(() => {
    if (!resumable || s.sessionId === null) { setLastActive(null); return; }
    let cancelled = false;
    api.sessions.lastActive(s.env, s.sessionId)
      .then((r) => { if (!cancelled) setLastActive(r.lastActive); })
      .catch(() => { if (!cancelled) setLastActive(null); });
    return () => { cancelled = true; };
  }, [resumable, s.env, s.sessionId]);

  const stop = (e: { stopPropagation: () => void }): void => { e.stopPropagation(); };
  const shortId = s.sessionId !== null && s.sessionId !== "" ? s.sessionId.slice(0, 8) : null;
  // The ✕ hits the same detach route for both states but MEANS different things: unlink a still-running
  // session (returns to Unassigned) vs delete an already-dead one. Label + warning make that explicit.
  const removeVerb = detached ? "Remove" : "Detach";
  const removeWarning = detached
    ? "Removes this closed session permanently"
    : "Detaches — leaves it running, returns to Unassigned";

  function handleOpen(): void {
    if (pending) return; // mid close/resume — ignore until it reconciles
    if (detached) { setShowRestore(true); return; } // never attach to a dead pane; offer restore instead
    onOpenSession(s.env, s.paneId, false, title);
  }

  return (
    <div className="flex items-center gap-1 group/session -mx-1 px-1 rounded hover:bg-muted">
      <button
        type="button"
        onPointerDown={stop}
        onClick={(e) => { stop(e); handleOpen(); }}
        className="flex items-center gap-1.5 flex-1 min-w-0 text-left py-0.5"
        title={pending ? (isClosing ? "Closing…" : "Resuming…") : detached ? "Session ended — click to restore" : "Open this session"}
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${detached ? "bg-slate-600" : (STATUS_DOT[s.live?.status ?? ""] ?? "bg-slate-500")}`} />
        <span className="text-xs truncate">
          {detached ? (
            <span className="text-muted-foreground">
              ⚠ {s.name}
              {isClosing
                ? <span className="text-muted-foreground/70"> · closing…</span>
                : lastActive !== null && <span className="text-muted-foreground/70"> · last active {relativeTime(lastActive)}</span>}
            </span>
          ) : (
            <>
              <span className="text-muted-foreground">{s.live?.status ?? "unknown"}</span>
              {s.tabLabel !== "" && (
                // Workspace/repo label intentionally omitted here — it lives in the terminal header now.
                <span className="text-muted-foreground/70"> · {s.tabLabel}</span>
              )}
            </>
          )}
        </span>
      </button>
      {shortId !== null && (
        <button
          type="button"
          onPointerDown={stop}
          onClick={(e) => { stop(e); void navigator.clipboard.writeText(s.sessionId ?? ""); }}
          className="shrink-0 font-mono text-[10px] text-muted-foreground/40 hover:text-muted-foreground p-1"
          title={`Claude session ${s.sessionId ?? ""} — click to copy`}
        >{shortId}</button>
      )}
      {!pending && (confirming ? (
        <div className="shrink-0 flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground" title={removeWarning}>{removeVerb}?</span>
          <button
            type="button"
            onPointerDown={stop}
            onClick={(e) => { stop(e); onDetachSession(s.env, s.paneId, s.sessionId); }}
            className="text-red-400/80 hover:text-red-400 text-xs leading-none p-1"
            title={removeWarning}
            aria-label={`Confirm ${removeVerb.toLowerCase()} session`}
          >✓</button>
          <button
            type="button"
            onPointerDown={stop}
            onClick={(e) => { stop(e); setConfirming(false); }}
            className="text-muted-foreground/60 hover:text-foreground text-xs leading-none p-1"
            title="Cancel"
            aria-label="Cancel"
          >✕</button>
        </div>
      ) : (
        <>
          {resumable && (
            <button
              type="button"
              onPointerDown={stop}
              onClick={(e) => { stop(e); onResumeSession(s.env, s.paneId, s.sessionId); }}
              className="shrink-0 text-muted-foreground/40 hover:text-emerald-400 text-xs leading-none p-1 opacity-0 group-hover/session:opacity-100 transition-opacity"
              title="Restore this session (claude --resume)"
              aria-label="Restore session"
            >⟲</button>
          )}
          {!detached && (
            <button
              type="button"
              onPointerDown={stop}
              onClick={(e) => { stop(e); setShowClose(true); }}
              className="shrink-0 text-muted-foreground/40 hover:text-orange-400 text-xs leading-none p-1 opacity-0 group-hover/session:opacity-100 transition-opacity"
              title="Close (kill) this session"
              aria-label="Close session"
            >⊗</button>
          )}
          <button
            type="button"
            onPointerDown={stop}
            onClick={(e) => { stop(e); setConfirming(true); }}
            className="shrink-0 text-muted-foreground/40 hover:text-red-400 text-xs leading-none p-1 opacity-0 group-hover/session:opacity-100 transition-opacity"
            title={detached ? "Remove this closed session (permanent)" : "Detach this session (keeps it running)"}
            aria-label={`${removeVerb} session`}
          >✕</button>
        </>
      ))}
      {showRestore && (
        <RestoreSessionModal
          name={s.name}
          sessionId={s.sessionId}
          lastActive={lastActive}
          resumable={resumable}
          onRestore={() => { onResumeSession(s.env, s.paneId, s.sessionId); }}
          onClose={() => { setShowRestore(false); }}
        />
      )}
      {showClose && (
        <CloseSessionModal
          name={s.name}
          taskTitle={title}
          env={s.env}
          paneId={s.paneId}
          tabId={s.tabId}
          sessionId={s.sessionId}
          status={s.live?.status ?? "unknown"}
          model={s.live?.model ?? null}
          ctxPct={s.live?.ctxPct ?? null}
          onClose={() => onCloseSession(s.env, s.paneId, s.sessionId)}
          onDismiss={() => { setShowClose(false); }}
        />
      )}
    </div>
  );
}
