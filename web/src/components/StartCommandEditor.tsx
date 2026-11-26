import type { SpawnPreset } from "@shared/board-schema";
import { START_COMMAND_MAX, START_COMMAND_TITLE_MAX } from "@shared/board-schema";
import type { JSX } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { startCommandProblem } from "../lib/start-command";

interface Props {
  readonly preset: SpawnPreset;
  readonly isNew: boolean;
  readonly onDone: (preset: SpawnPreset) => void;
  readonly onCancel: () => void;
}

export function StartCommandEditor({ preset, isNew, onDone, onCancel }: Props): JSX.Element {
  const [title, setTitle] = useState(preset.title);
  const [text, setText] = useState(preset.text);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const headingId = useId();

  useEffect(() => { textRef.current?.focus(); }, []);

  const trimmed = text.trim();
  const problem = startCommandProblem(text);

  function done(): void {
    if (problem !== null) return;
    onDone({ id: preset.id, title: title.trim(), text: trimmed });
  }

  return (
    // No backdrop dismissal: a stray click must not discard a long command.
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
      role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}>
      <div className="bg-card border border-border rounded-lg w-[min(560px,92vw)] max-h-[90vh] flex flex-col">
        <h2 id={headingId} className="text-foreground font-semibold px-6 pt-6 pb-4">
          {isNew ? "New start command" : "Edit start command"}
        </h2>
        <div className="px-6 overflow-y-auto flex-1 flex flex-col">
          <label className="block text-xs text-muted-foreground mb-1" htmlFor={`${headingId}-title`}>Title</label>
          <input id={`${headingId}-title`} maxLength={START_COMMAND_TITLE_MAX}
            className="w-full bg-background border border-border rounded px-3 py-2 h-[38px] text-foreground text-sm placeholder:text-muted-foreground/70"
            placeholder="Optional — the first line is shown when empty"
            value={title} onChange={(e) => { setTitle(e.target.value); }} />
          <label className="block text-xs text-muted-foreground mt-4 mb-1" htmlFor={`${headingId}-text`}>
            Text — sent as the session&apos;s first message
          </label>
          <textarea id={`${headingId}-text`} ref={textRef} rows={14}
            className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-xs font-mono leading-relaxed resize-y placeholder:text-muted-foreground/70"
            placeholder="/plan" value={text} onChange={(e) => { setText(e.target.value); }} />
          <div className="flex justify-between text-[11px] text-muted-foreground mt-1">
            <span>{trimmed === "" ? "" : trimmed.startsWith("/") ? "sent as a slash command" : "sent as a plain message, not a slash command"}</span>
            <span className={trimmed.length > START_COMMAND_MAX ? "text-destructive" : ""}>
              {String(trimmed.length)} / {String(START_COMMAND_MAX)}
            </span>
          </div>
          {trimmed !== "" && problem !== null && <p className="text-xs text-destructive mt-2">{problem}</p>}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 mt-4 border-t border-border">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
          <button onClick={done} disabled={problem !== null}
            className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50">Done</button>
        </div>
      </div>
    </div>
  );
}
