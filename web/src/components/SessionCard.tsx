import type { JSX } from "react";

interface Props {
  readonly onOpen: () => void; // card body opens the live terminal (click / Enter / Space)
  readonly indicator: JSX.Element; // ⊘/✓ (attention) or a status dot (unassigned) — caller styles it
  readonly title: string;
  readonly subtitle: string;
  readonly meta?: string; // compact "model · ctx%" line; omitted when unknown
  readonly age?: string; // attention only (e.g. "2m ago")
  readonly preview?: { readonly text: string; readonly captured: boolean } | null; // attention lastLines
  readonly action?: { readonly label: string; readonly onClick: () => void }; // e.g. "＋ Create task"
  readonly secondaryAction?: { readonly label: string; readonly onClick: () => void }; // e.g. "Assign to task"
}

// Shared session card for the attention panel and the Unassigned view. Owns the click-to-open a11y
// (role/tabIndex/keyboard) and the inner action-button stopPropagation ONCE, so the dual-action trap
// (a clickable card that also holds a button) is solved in a single place rather than per surface.
export function SessionCard({ onOpen, indicator, title, subtitle, meta, age, preview, action, secondaryAction }: Props): JSX.Element {
  const actions = [action, secondaryAction].filter((a): a is { label: string; onClick: () => void } => a !== undefined);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => { onOpen(); }}
      onKeyDown={(e) => {
        // The inner action button bubbles here — only act when the event targets the card itself.
        // Space is prevented so the page doesn't scroll.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
      }}
      className="bg-card border border-border rounded-lg p-3 transition-colors cursor-pointer hover:border-primary"
      title="Open live terminal"
    >
      <div className="flex items-center gap-2 mb-1">
        {indicator}
        <span className="text-foreground text-sm font-medium truncate flex-1">{title}</span>
        {age !== undefined && <span className="text-[11px] text-muted-foreground/70 shrink-0">{age}</span>}
      </div>
      <div className="text-[11px] text-muted-foreground/70 mb-1.5">{subtitle}</div>
      {meta !== undefined && meta !== "" && (
        <div className="text-[11px] text-muted-foreground/60 font-mono tabular-nums mb-1.5">{meta}</div>
      )}
      {preview !== undefined && preview !== null && (
        preview.captured ? (
          // Bottom-anchored: when the snapshot overflows the box, clip the top so the NEWEST lines stay
          // visible (the blocking prompt for attention; current activity for the Unassigned mini-terminal).
          <div className="max-h-24 overflow-hidden bg-background rounded flex flex-col justify-end">
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted-foreground px-2 py-1.5">
              {preview.text}
            </pre>
          </div>
        ) : (
          <p className="font-mono text-[11px] text-muted-foreground/60 italic">no output captured — open terminal</p>
        )
      )}
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={(e) => { e.stopPropagation(); a.onClick(); }}
              className="px-2 py-0.5 text-[11px] rounded border border-border text-muted-foreground hover:text-foreground hover:border-primary"
            >{a.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
