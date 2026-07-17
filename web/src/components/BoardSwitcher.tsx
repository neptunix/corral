import type { Board } from "@shared/board-schema";
import type { JSX } from "react";

import { ThemeSwitch } from "./ThemeSwitch";

interface Props {
  readonly boards: readonly Board[];
  readonly activeBoardId: string | null;
  readonly unassignedCount: number;
  readonly attentionCounts: ReadonlyMap<string, number>; // per-board attention count → badge on each board
  readonly unassignedAttentionCount: number;             // unassigned sessions needing attention → ⊙ badge
  readonly showingUnassigned: boolean;
  readonly onSelect: (boardId: string) => void;
  readonly onUnassigned: () => void;
  readonly onNewBoard: () => void;
}

export function BoardSwitcher({
  boards, activeBoardId, unassignedCount, attentionCounts, unassignedAttentionCount,
  showingUnassigned, onSelect, onUnassigned, onNewBoard,
}: Props): JSX.Element {
  return (
    <nav className="flex items-center gap-1 border-b border-border px-4 py-2">
      {boards.map((b) => {
        const attn = attentionCounts.get(b.id) ?? 0;
        return (
          <button
            key={b.id}
            onClick={() => { onSelect(b.id); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              activeBoardId === b.id && !showingUnassigned
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {b.label}
            {attn > 0 && (
              <span
                className="min-w-4 px-1 h-4 rounded-full bg-destructive text-destructive-foreground text-[10px] leading-4 text-center"
                title={`${String(attn)} session(s) need you on this board`}
              >{attn}</span>
            )}
          </button>
        );
      })}
      <button
        onClick={onNewBoard}
        className="px-3 py-1.5 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        + New board
      </button>
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onUnassigned}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
            showingUnassigned ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Unassigned sessions{unassignedCount > 0 ? ` (${String(unassignedCount)})` : ""}
          {unassignedAttentionCount > 0 && (
            <span
              className="min-w-4 px-1 h-4 rounded-full bg-destructive text-destructive-foreground text-[10px] leading-4 text-center"
              title={`${String(unassignedAttentionCount)} unassigned session(s) need you`}
            >⊙{unassignedAttentionCount}</span>
          )}
        </button>
        <ThemeSwitch />
      </div>
    </nav>
  );
}
