import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Board, Column } from "@shared/board-schema";
import { ColumnTypeSchema, defaultColumnId, generateColumnId } from "@shared/board-schema";
import type { CSSProperties, JSX } from "react";
import { useState } from "react";

interface Props {
  readonly board: Board;
  readonly onSave: (patch: { label?: string; columns?: Column[] }) => void;
  readonly onClose: () => void;
}

interface RowProps {
  readonly col: Column;
  readonly isLanding: boolean;
  readonly skipsClosedAbove: boolean; // the landing row is NOT row 0 — say why, right here
  readonly canRemove: boolean;
  readonly onRename: (id: string, label: string) => void;
  readonly onRetype: (id: string, value: string) => void;
  readonly onRemove: (id: string) => void;
}

function SortableColumnRow({ col, isLanding, skipsClosedAbove, canRemove, onRename, onRetype, onRemove }: RowProps): JSX.Element {
  // No `attributes` in the destructure — see the handle below. `noUnusedLocals` fails on it otherwise.
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: col.id });
  // exactOptionalPropertyTypes: CSS.Transform.toString returns `string | undefined`, and an explicit
  // `undefined` is NOT assignable to an optional CSSProperties field — spread it in conditionally.
  const t = CSS.Transform.toString(transform);
  const style: CSSProperties = {
    ...(t !== undefined ? { transform: t } : {}),
    ...(transition !== undefined ? { transition } : {}),
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <div className="flex gap-2 items-center">
        {/* listeners on the HANDLE only — a row-wide sensor would hijack text selection in the label
            input. `attributes` is deliberately NOT spread: it sets tabIndex=0, role and
            aria-roledescription, which would put a focusable "button" in the tab order that does
            nothing at all, because §1.3 ships pointer-only reordering with no KeyboardSensor. When
            keyboard reordering is retrofitted, this span becomes a real <button> and takes
            `attributes` then. aria-hidden keeps it out of the accessibility tree meanwhile. */}
        <span
          {...listeners}
          aria-hidden="true"
          className="cursor-grab select-none px-1 text-muted-foreground hover:text-foreground"
          title="Drag to reorder"
        >⠿</span>
        <input className="flex-1 bg-background border border-border rounded px-2 py-1 text-foreground text-sm"
          value={col.label} onChange={(e) => { onRename(col.id, e.target.value); }} />
        <select
          className="bg-background border border-border rounded px-2 py-1 text-foreground text-sm"
          value={col.type ?? ""}
          onChange={(e) => { onRetype(col.id, e.target.value); }}
          title="Column type"
        >
          <option value="">—</option>
          <option value="to-do">To-do</option>
          <option value="in-progress">In-progress</option>
          <option value="closed">Closed</option>
        </select>
        {canRemove && (
          <button onClick={() => { onRemove(col.id); }}
            className="px-2 text-destructive hover:text-destructive/80 text-sm">×</button>
        )}
      </div>
      {isLanding && (
        // The long form is the whole point of the tag in the case §1.2 exists for: when a closed
        // column sits at position 0, "the column above is closed" makes the skip legible at the
        // moment of the decision instead of looking like a bug.
        <p className="text-[11px] text-muted-foreground pl-6 mt-0.5">
          {skipsClosedAbove ? "new cards start here — the column above is closed" : "new cards start here"}
        </p>
      )}
    </div>
  );
}

export function BoardSettingsModal({ board, onSave, onClose }: Props): JSX.Element {
  const [label, setLabel] = useState(board.label);
  const [columns, setColumns] = useState<Column[]>([...board.columns]);
  const [newColLabel, setNewColLabel] = useState("");

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // Recomputed from live modal state, so the tag follows both a drag AND a type change. Never pinned
  // to row 0: when row 0 is the closed column the tag must point at the row below it.
  const landingId = defaultColumnId(columns);

  function handleDragEnd(e: DragEndEvent): void {
    const { active, over } = e;
    if (over === null || active.id === over.id) return;
    setColumns((prev) => {
      const from = prev.findIndex((c) => c.id === active.id);
      const to = prev.findIndex((c) => c.id === over.id);
      if (from === -1 || to === -1) return prev;
      return arrayMove(prev, from, to);
    });
  }

  function addColumn(): void {
    if (!newColLabel.trim()) return;
    setColumns((prev) => [...prev, { id: generateColumnId(), label: newColLabel.trim() }]);
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
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={columns.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2 mb-3">
              {columns.map((col) => (
                <SortableColumnRow
                  key={col.id}
                  col={col}
                  isLanding={col.id === landingId}
                  skipsClosedAbove={col.id === landingId && columns[0]?.id !== landingId}
                  canRemove={columns.length > 1}
                  onRename={renameColumn}
                  onRetype={setColumnType}
                  onRemove={removeColumn}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
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
