import type { Board } from "@shared/board-schema";
import type { AttentionMap, EnvState } from "@shared/schema";
import { useState, type JSX } from "react";

import { SessionCard } from "./SessionCard";
import { boardAttention } from "../lib/attention";
import { envLabel } from "../lib/env";
import { parseKey } from "../lib/protocol";

function formatAge(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${String(Math.floor(diffMs / 60_000))}m ago`;
  if (diffMs < 86_400_000) return `${String(Math.floor(diffMs / 3_600_000))}h ago`;
  return `${String(Math.floor(diffMs / 86_400_000))}d ago`;
}

interface Props {
  readonly attention: AttentionMap;
  readonly boards: readonly Board[];
  readonly envs: Readonly<Record<string, EnvState>>;
  readonly activeBoardId: string | null;
  readonly onOpen: (env: string, paneId: string) => void;
}

// Attention feed, scoped to the active board (design 2026-07-10): only sessions bound to a task on
// this board. Unassigned-attention items (bound to no board) surface via the "Unassigned sessions"
// switcher badge + the Unassigned view instead — they never appear here.
export function AttentionFeed({ attention, boards, envs, activeBoardId, onOpen }: Props): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const entries = activeBoardId !== null ? boardAttention(attention, boards, activeBoardId) : [];
  const count = entries.length;

  if (collapsed) {
    return (
      <div className="shrink-0 w-12 border-l border-border flex flex-col items-center pt-3">
        <button
          type="button"
          onClick={() => { setCollapsed(false); }}
          className="relative text-muted-foreground hover:text-foreground"
          title="Show attention feed"
        >
          <span className="text-lg" aria-hidden>🔔</span>
          {count > 0 && (
            <span className="absolute -top-1 -right-2 min-w-4 px-1 h-4 rounded-full bg-destructive text-destructive-foreground text-[10px] leading-4 text-center">
              {count}
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <aside className="shrink-0 w-80 border-l border-border flex flex-col overflow-hidden bg-card">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="text-foreground text-sm font-semibold">Attention</span>
        <span className={`text-xs px-1.5 py-0.5 rounded-full ${count > 0 ? "bg-destructive text-destructive-foreground" : "bg-muted text-muted-foreground"}`}>
          {count}
        </span>
        <button
          type="button"
          onClick={() => { setCollapsed(true); }}
          className="ml-auto text-muted-foreground hover:text-foreground text-sm"
          title="Collapse"
        >⇥</button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
        {count === 0 ? (
          <p className="text-xs text-muted-foreground text-center mt-4">Nothing needs you on this board.</p>
        ) : (
          entries.map((entry) => {
            const { key, record, taskTitle } = entry;
            const { env, paneId } = parseKey(key);
            const blocked = record.state === "blocked";
            const sessionName = record.sessionName ?? paneId;
            return (
              <SessionCard
                key={key}
                onOpen={() => { onOpen(env, paneId); }}
                indicator={<span className={blocked ? "text-destructive" : "text-success"} aria-hidden>{blocked ? "⊘" : "✓"}</span>}
                title={taskTitle !== "" ? taskTitle : sessionName}
                subtitle={`${blocked ? "blocked" : "finished"} · ${sessionName} · ${envLabel(envs, env)}`}
                age={formatAge(record.since)}
                preview={{ text: record.lastLines, captured: record.captured }}
              />
            );
          })
        )}
      </div>
    </aside>
  );
}
