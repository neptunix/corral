import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Board, Column, SpawnPreset } from "@shared/board-schema";
import { ColumnTypeSchema, defaultColumnId, generateColumnId, generateSpawnPresetId } from "@shared/board-schema";
import type { CSSProperties, JSX } from "react";
import { useEffect, useState } from "react";

interface Props {
  readonly board: Board;
  // Returns a promise that REJECTS on a refused save, so handleSave can keep the modal open and
  // show the server's message instead of closing on a failure it never saw.
  readonly onSave: (patch: { label?: string; columns?: Column[]; spawnPresets?: SpawnPreset[]; defaultSpawnPresetId?: string | null }) => Promise<void>;
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
        <input className="flex-1 bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm"
          value={col.label} onChange={(e) => { onRename(col.id, e.target.value); }} />
        <select
          className="bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm"
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
  const [presets, setPresets] = useState<SpawnPreset[]>([...board.spawnPresets]);
  const [defaultPresetId, setDefaultPresetId] = useState<string | null>(board.defaultSpawnPresetId);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [onClose]);

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

  function addPreset(): void {
    setPresets((prev) => [...prev, { id: generateSpawnPresetId(), text: "" }]);
  }
  function setPresetText(id: string, text: string): void {
    setPresets((prev) => prev.map((p) => p.id === id ? { ...p, text } : p));
  }
  function removePreset(id: string): void {
    setPresets((prev) => prev.filter((p) => p.id !== id));
    setDefaultPresetId((cur) => cur === id ? null : cur);
  }

  async function handleSave(): Promise<void> {
    // These pre-checks cover the rejections this form can itself produce (blank name, bad/oversized/
    // too-many presets) — they can't cover a 503/404/dropped connection, so a rejected `onSave` below
    // is what makes those visible, through this same saveError channel, instead of silent.
    if (label.trim() === "") { setSaveError("A board needs a name."); return; }
    // Blank rows are dropped rather than rejected: an empty row is "I changed my mind", not an error.
    const kept = presets.filter((p) => p.text.trim() !== "").map((p) => ({ ...p, text: p.text.trim() }));
    const bad = kept.find((p) => !/^[/A-Za-z0-9]/.test(p.text));
    if (bad !== undefined) {
      setSaveError(`A start command must begin with "/" or a letter or digit — "${bad.text.slice(0, 24)}" would reach the CLI as a flag, not as the prompt.`);
      return;
    }
    const tooLong = kept.find((p) => p.text.length > 2000);
    if (tooLong !== undefined) {
      setSaveError(`A start command is limited to 2000 characters — "${tooLong.text.slice(0, 24)}…" is ${String(tooLong.text.length)}.`);
      return;
    }
    if (kept.length > 20) {
      setSaveError(`At most 20 start commands per board — remove ${String(kept.length - 20)}.`);
      return;
    }
    // Duplicate ids cannot happen through this UI (generateSpawnPresetId mints each row), so there is
    // no fourth check — the server's rule guards the API, not this form.
    setSaveError(null);
    setSaving(true);
    try {
      await onSave({
        label: label.trim(),
        columns,
        spawnPresets: kept,
        defaultSpawnPresetId: kept.some((p) => p.id === defaultPresetId) ? defaultPresetId : null,
      });
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg w-[min(560px,92vw)] max-h-[80vh] flex flex-col" onClick={(e) => { e.stopPropagation(); }}>
        <h2 className="text-foreground font-semibold px-6 pt-6 pb-4">Board settings</h2>
        <div className="px-6 overflow-y-auto flex-1">
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
        <label className="block text-xs text-muted-foreground mb-2">Start commands</label>
        <div className="space-y-2 mb-3">
          {presets.map((p) => (
            <div key={p.id}>
              <div className="flex gap-2 items-center">
                <input type="radio" name="defaultSpawnPreset" className="accent-primary" title="Default for new sessions"
                  checked={defaultPresetId === p.id} onChange={() => { setDefaultPresetId(p.id); }} />
                <input className="flex-1 bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm placeholder:text-muted-foreground/70"
                  placeholder="/plan" value={p.text} onChange={(e) => { setPresetText(p.id, e.target.value); }} />
                <button onClick={() => { removePreset(p.id); }}
                  className="px-2 text-destructive hover:text-destructive/80 text-sm">×</button>
              </div>
              {/* Per-ROW, not a passive hint under the list: a plain-text first message is a legitimate
                  preset, so this informs rather than blocks — but only if it says WHICH row. */}
              {p.text.trim() !== "" && !p.text.trim().startsWith("/") && (
                <p className="text-[11px] text-muted-foreground pl-6 mt-0.5">sent as a plain message, not a slash command</p>
              )}
            </div>
          ))}
          <label className="flex gap-2 items-center text-xs text-muted-foreground">
            <input type="radio" name="defaultSpawnPreset" className="accent-primary"
              checked={defaultPresetId === null} onChange={() => { setDefaultPresetId(null); }} />
            no default command
          </label>
        </div>
        <button onClick={addPreset} className="px-3 py-1 mb-4 bg-muted text-foreground text-sm rounded hover:bg-muted/80">Add start command</button>
        </div>
        <div className="flex items-center gap-2 px-6 py-4 border-t border-border bg-card">
          {saveError !== null && <p className="text-xs text-destructive min-w-0 flex-1">{saveError}</p>}
          <div className="flex gap-2 shrink-0 ml-auto">
            <button onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
            <button onClick={() => { void handleSave(); }} disabled={saving}
              className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50">Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
