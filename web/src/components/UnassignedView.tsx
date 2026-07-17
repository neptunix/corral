import type { Board } from "@shared/board-schema";
import type { SessionRow } from "@shared/schema";
import type { JSX } from "react";
import { useEffect, useState } from "react";

import { AssignToTaskModal } from "./AssignToTaskModal";
import { CreateTaskModal } from "./CreateTaskModal";
import { SessionCard } from "./SessionCard";
import { api } from "../lib/api";
import { toSnapshotPreview } from "../lib/preview";

const STATUS_COLOR: Record<string, string> = {
  working: "text-emerald-400 light:text-emerald-600", idle: "text-slate-500",
  blocked: "text-red-400 light:text-red-600", done: "text-sky-400 light:text-sky-600",
};

// Re-read each visible card's pane while the Unassigned view is open (read-only, no takeover). Cards
// unmount when you leave the view, which clears the interval — so previews only poll while on-screen.
const PREVIEW_REFRESH_MS = 5000;

interface CardProps {
  readonly session: SessionRow;
  readonly onOpen: (env: string, paneId: string, awaitAgent?: boolean, title?: string) => void;
  readonly onCreate: (session: SessionRow) => void;
  readonly onAssign: (session: SessionRow) => void;
}

function UnassignedCard({ session, onOpen, onCreate, onAssign }: CardProps): JSX.Element {
  const { env, paneId } = session;
  // The card's display name (herdr tab label); "" when unnamed so the modal header falls back to paneId.
  const label = session.tab !== "?" ? session.tab : "";
  const [text, setText] = useState<string | null>(null); // null = first read still pending
  const [sessionName, setSessionName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function load(): Promise<void> {
      try {
        const read = await api.sessions.read(env, paneId, 50, controller.signal);
        if (!cancelled) { setText(read.text); setSessionName(read.sessionName); }
      } catch {
        // Read failed / aborted (env unreachable, herdr timeout, or the card unmounted mid-read): keep
        // the last good snapshot; only fall to "no output" if the first read never succeeded.
        if (!cancelled) setText((prev) => prev ?? "");
      } finally {
        // Self-scheduling (not setInterval): the next read is queued only AFTER this one settles, so a
        // slow remote read can never stack concurrent reads on one pane. Jitter de-locksteps the cards
        // so N previews don't fire their SSH reads in one synchronized burst.
        if (!cancelled) timer = setTimeout(() => { void load(); }, PREVIEW_REFRESH_MS + Math.random() * 1000);
      }
    }
    void load();
    // abort() cancels the in-flight read so leaving the view doesn't leave an SSH round-trip running.
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); controller.abort(); };
  }, [env, paneId]);

  // Title precedence: Claude's own session name (parsed from the pane) → herdr tab label → paneId.
  // sessionName arrives a couple seconds after mount (first live read); until then the herdr label shows.
  const displayTitle = sessionName !== null && sessionName !== "" ? sessionName : (label !== "" ? label : paneId);

  return (
    <SessionCard
      onOpen={() => { onOpen(env, paneId, false, label); }}
      indicator={<span className={STATUS_COLOR[session.status] ?? "text-slate-400 light:text-slate-500"} aria-hidden>●</span>}
      title={displayTitle}
      subtitle={`${session.workspace} / ${session.tab} · ${env}`}
      meta={((): string => {
        const sl = session.statusline;
        if (sl === null) return "";
        const p: string[] = [];
        if (sl.model !== null) p.push(sl.model);
        if (sl.ctx.pct !== null) p.push(`ctx ${String(sl.ctx.pct)}%`);
        return p.join(" · ");
      })()}
      preview={toSnapshotPreview(text)}
      action={{ label: "＋ Create task", onClick: () => { onCreate(session); } }}
      secondaryAction={{ label: "⧉ Assign to task", onClick: () => { onAssign(session); } }}
    />
  );
}

interface Props {
  readonly sessions: readonly SessionRow[];
  readonly boards: readonly Board[];
  readonly onOpen: (env: string, paneId: string, awaitAgent?: boolean, title?: string) => void;
  readonly onCreateTask: (boardId: string, title: string, session: SessionRow, sessionName: string | null) => void;
  readonly onAssignTask: (boardId: string, taskId: string, session: SessionRow) => void;
}

// Global list of every session bound to no task. Same SessionCard as the attention panel (shared look),
// with a live mini-terminal snapshot: each card opens the live terminal on click, previews the pane's
// last lines, and offers "＋ Create task" (fires to the chosen board).
export function UnassignedView({ sessions, boards, onOpen, onCreateTask, onAssignTask }: Props): JSX.Element {
  const [creating, setCreating] = useState<SessionRow | null>(null);
  const [assigning, setAssigning] = useState<SessionRow | null>(null);
  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">Unassigned Sessions</h2>
      {sessions.length === 0 && <p className="text-muted-foreground text-sm">No unassigned sessions.</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
        {sessions.map((s) => (
          <UnassignedCard
            key={`${s.env}:${s.paneId}`}
            session={s}
            onOpen={onOpen}
            onCreate={(session) => { setCreating(session); }}
            onAssign={(session) => { setAssigning(session); }}
          />
        ))}
      </div>
      {creating !== null && (
        <CreateTaskModal
          boards={boards}
          defaultTitle={creating.tab !== "?" ? creating.tab : ""}
          onConfirm={(bid, title) => { onCreateTask(bid, title, creating, null); setCreating(null); }}
          onClose={() => { setCreating(null); }}
        />
      )}
      {assigning !== null && (
        <AssignToTaskModal
          boards={boards}
          session={assigning}
          onConfirm={(bid, tid) => { onAssignTask(bid, tid, assigning); setAssigning(null); }}
          onClose={() => { setAssigning(null); }}
        />
      )}
    </div>
  );
}
