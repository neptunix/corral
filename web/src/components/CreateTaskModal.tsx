import type { Board } from "@shared/board-schema";
import type { JSX } from "react";
import { useState } from "react";

interface Props {
  readonly boards: readonly Board[];
  readonly defaultTitle: string;
  // Header text (default suits the from-session flow); the "+ New task" button passes "New task".
  readonly heading?: string;
  // Pre-selects a board in the picker (the active board for "+ New task"); defaults to the first.
  readonly defaultBoardId?: string;
  readonly onConfirm: (boardId: string, title: string) => void;
  readonly onClose: () => void;
}

// Used by UnassignedView (from-session) and App's "+ New task" button. Callers compute defaultTitle;
// the modal never sees the session itself.
export function CreateTaskModal({ boards, defaultTitle, heading = "Create task from session", defaultBoardId, onConfirm, onClose }: Props): JSX.Element {
  const [title, setTitle] = useState(defaultTitle);
  const [boardId, setBoardId] = useState(defaultBoardId ?? boards[0]?.id ?? "");
  const noBoards = boards.length === 0;
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg p-6 w-96" onClick={(e) => { e.stopPropagation(); }}>
        <h2 className="text-foreground font-semibold mb-4">{heading}</h2>
        <input
          className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm mb-3"
          placeholder="Task title" value={title} onChange={(e) => { setTitle(e.target.value); }}
          autoFocus
        />
        <select
          className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm mb-4"
          value={boardId} onChange={(e) => { setBoardId(e.target.value); }}
        >
          {boards.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
        </select>
        {noBoards && (
          <p className="text-xs text-warning mb-3">Create a board first — this task has nowhere to go.</p>
        )}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
          <button
            disabled={noBoards}
            onClick={() => {
              // Seed-once state can be "" if the modal mounted before boards loaded; the controlled
              // <select value=""> visually shows the first option, so confirm must match what's shown.
              const bid = boardId !== "" ? boardId : (boards[0]?.id ?? "");
              if (title.trim() && bid !== "") onConfirm(bid, title.trim());
            }}
            className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >Create</button>
        </div>
      </div>
    </div>
  );
}
