import { useEffect, useRef, type JSX } from "react";

interface Props {
  /** Receives the pasted text. Not called for an empty clipboard. */
  readonly onText: (text: string) => void;
  readonly onCancel: () => void;
}

/**
 * Fallback for browsers that will not hand over the clipboard.
 *
 * `navigator.clipboard.readText` is the one-tap path, but Firefox refuses it outright ("The request
 * is not allowed by the user agent…") and an insecure origin has no clipboard API at all. What every
 * browser does support is the native paste menu over a REAL textarea — which the terminal can never
 * be (see KeyBar). So put a real one on screen for the length of one paste, take what lands in it,
 * and get out of the way.
 */
export function PastePrompt({ onText, onCancel }: Props): JSX.Element {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Focus rather than autoFocus: iOS raises its callout on a long press over a focused field, and the
  // attribute is unreliable inside a freshly mounted overlay.
  useEffect(() => { ref.current?.focus(); }, []);

  function submit(text: string): void {
    if (text !== "") onText(text);
    else onCancel();
  }

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-4"
      // Escape must not reach the window listener that closes the whole session modal.
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}
      onClick={(e) => { e.stopPropagation(); }}
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-3 flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">Long-press the box and choose Paste.</p>
        <textarea
          ref={ref}
          rows={3}
          className="w-full rounded border border-border bg-input text-foreground text-sm p-2 font-mono"
          // The paste event carries the text directly, so the common path needs no second tap.
          onPaste={(e) => { e.preventDefault(); submit(e.clipboardData.getData("text/plain")); }}
        />
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            className="h-9 px-3 rounded border border-border text-sm text-muted-foreground touch-manipulation"
            onClick={onCancel}
          >Cancel</button>
          <button
            type="button"
            className="h-9 px-3 rounded border border-primary bg-primary text-primary-foreground text-sm touch-manipulation"
            // Second path, for a browser that fills the field without firing a usable paste event.
            onClick={() => { submit(ref.current?.value ?? ""); }}
          >Send</button>
        </div>
      </div>
    </div>
  );
}
