import type { Board, Column } from "@shared/board-schema";
import { ColumnTypeSchema } from "@shared/board-schema";
import { nanoid } from "nanoid";
import type { JSX } from "react";
import { useState } from "react";

interface Props {
  readonly board: Board;
  readonly onSave: (patch: { label?: string; columns?: Column[] }) => void;
  readonly onClose: () => void;
}

export function BoardSettingsModal({ board, onSave, onClose }: Props): JSX.Element {
  const [label, setLabel] = useState(board.label);
  const [columns, setColumns] = useState<Column[]>([...board.columns]);
  const [newColLabel, setNewColLabel] = useState("");

  function addColumn(): void {
    if (!newColLabel.trim()) return;
    setColumns((prev) => [...prev, { id: nanoid(8), label: newColLabel.trim() }]);
    setNewColLabel("");
  }

  function removeColumn(id: string): void {
    setColumns((prev) => prev.filter((c) => c.id !== id));
  }

  function renameColumn(id: string, newLabel: string): void {
    setColumns((prev) => prev.map((c) => c.id === id ? { ...c, label: newLabel } : c));
  }

  function setColumnType(id: string, value: string): void {
    setColumns((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        if (value === "") {
          const { type: _drop, ...rest } = c;
          return rest;
        }
        const parsed = ColumnTypeSchema.safeParse(value);
        return parsed.success ? { ...c, type: parsed.data } : c;
      }),
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg p-6 w-[400px]" onClick={(e) => { e.stopPropagation(); }}>
        <h2 className="text-foreground font-semibold mb-4">Board settings</h2>
        <label className="block text-xs text-muted-foreground mb-1">Board name</label>
        <input className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm mb-4"
          value={label} onChange={(e) => { setLabel(e.target.value); }} />
        <label className="block text-xs text-muted-foreground mb-2">Columns</label>
        <div className="space-y-2 mb-3">
          {columns.map((col) => (
            <div key={col.id} className="flex gap-2">
              <input className="flex-1 bg-background border border-border rounded px-2 py-1 text-foreground text-sm"
                value={col.label} onChange={(e) => { renameColumn(col.id, e.target.value); }} />
              <select
                className="bg-background border border-border rounded px-2 py-1 text-foreground text-sm"
                value={col.type ?? ""}
                onChange={(e) => { setColumnType(col.id, e.target.value); }}
                title="Column type"
              >
                <option value="">—</option>
                <option value="to-do">To-do</option>
                <option value="in-progress">In-progress</option>
                <option value="closed">Closed</option>
              </select>
              {columns.length > 1 && (
                <button onClick={() => { removeColumn(col.id); }}
                  className="px-2 text-destructive hover:text-destructive/80 text-sm">×</button>
              )}
            </div>
          ))}
        </div>
        <div className="flex gap-2 mb-4">
          <input className="flex-1 bg-background border border-border rounded px-2 py-1 text-foreground text-sm placeholder:text-muted-foreground/70"
            placeholder="New column…" value={newColLabel} onChange={(e) => { setNewColLabel(e.target.value); }}
            onKeyDown={(e) => { if (e.key === "Enter") addColumn(); }} />
          <button onClick={addColumn} className="px-3 py-1 bg-muted text-foreground text-sm rounded hover:bg-muted/80">Add</button>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
          <button onClick={() => { onSave({ label: label.trim(), columns }); onClose(); }}
            className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90">Save</button>
        </div>
      </div>
    </div>
  );
}
