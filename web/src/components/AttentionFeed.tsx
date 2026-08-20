import type { EnvState } from "@shared/schema";
import type { JSX } from "react";

import { SessionCard } from "./SessionCard";
import type { BoardAttentionEntry } from "../lib/attention";
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
  readonly entries: readonly BoardAttentionEntry[];
  readonly envs: Readonly<Record<string, EnvState>>;
  readonly onOpen: (env: string, paneId: string) => void;
  readonly onClose: () => void;
}

// Presentational only. Board scoping and the collapsed/expanded decision both live in SideRail, because
// two independent open flags would let both panels show at once and there is room for one.
export function AttentionFeed({ entries, envs, onOpen, onClose }: Props): JSX.Element {
  const count = entries.length;

  return (
    <aside id="attention-panel" className="shrink-0 w-80 border-l border-border flex flex-col overflow-hidden bg-card">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="text-foreground text-sm font-semibold">Attention</span>
        <span className={`text-xs px-1.5 py-0.5 rounded-full ${count > 0 ? "bg-destructive text-destructive-foreground" : "bg-muted text-muted-foreground"}`}>
          {count}
        </span>
        <button
          type="button"
          onClick={onClose}
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
