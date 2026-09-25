import type { BoardFrame } from "@shared/board-schema";
import { useState, type JSX } from "react";

import { AttentionBadges } from "./AttentionMarks";
import { GearIcon } from "./icons/gearIcon";
import { SettingsModal } from "./SettingsModal";
import { ThemeSwitch } from "./ThemeSwitch";
import { ZERO_COUNTS, type AttentionCounts } from "../lib/attention";

interface Props {
  readonly boards: readonly BoardFrame[];
  readonly activeBoardId: string | null;
  readonly unassignedCount: number;
  readonly attentionCounts: ReadonlyMap<string, AttentionCounts>; // per-board blocked/finished → badges on each board
  readonly unassignedAttentionCount: AttentionCounts;             // unassigned sessions needing attention → badges
  readonly showingUnassigned: boolean;
  readonly onSelect: (boardId: string) => void;
  readonly onUnassigned: () => void;
  readonly onNewBoard: () => void;
}

export function BoardSwitcher({
  boards, activeBoardId, unassignedCount, attentionCounts, unassignedAttentionCount,
  showingUnassigned, onSelect, onUnassigned, onNewBoard,
}: Props): JSX.Element {
  const [showSettings, setShowSettings] = useState(false);
  return (
    <>
      <nav className="flex items-center gap-1 border-b border-border px-4 py-2">
        {boards.map((b) => {
          const attn = attentionCounts.get(b.id) ?? ZERO_COUNTS;
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
              <AttentionBadges counts={attn} scope="on this board" />
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
            <AttentionBadges counts={unassignedAttentionCount} scope="unassigned" />
          </button>
          <button
            type="button"
            onClick={() => { setShowSettings(true); }}
            aria-label="Settings"
            title="Settings"
            className="px-2.5 py-1.5 rounded-md bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <GearIcon className="w-4 h-4" />
          </button>
          <ThemeSwitch />
        </div>
      </nav>
      {showSettings && <SettingsModal onClose={() => { setShowSettings(false); }} />}
    </>
  );
}
