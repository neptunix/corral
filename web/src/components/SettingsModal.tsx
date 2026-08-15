import { useEffect, useState, type JSX } from "react";

import {
  clampScrollSpeed, readTerminalPrefs, writeTerminalPrefs,
  SCROLL_SPEED_DEFAULT, SCROLL_SPEED_MAX, SCROLL_SPEED_MIN,
} from "../lib/terminal-prefs";

interface Props {
  readonly onClose: () => void;
}

// App-wide operator preferences. Everything here is per-device (localStorage), which is the point for
// scroll speed: a trackpad and a phone want different multipliers and each browser keeps its own.
export function SettingsModal({ onClose }: Props): JSX.Element {
  const [scrollSpeed, setScrollSpeed] = useState<number>(() => readTerminalPrefs().scrollSpeed);

  // Esc closes, as it does in every other modal here.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  // Persisted on every move rather than on a Save button: the terminal reads the value when a session
  // opens, so the tuning loop is drag → close → open a session → scroll.
  function update(value: number): void {
    const next = clampScrollSpeed(value);
    setScrollSpeed(next);
    writeTerminalPrefs({ scrollSpeed: next });
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg w-[min(420px,92vw)] flex flex-col"
        onClick={(e) => { e.stopPropagation(); }}
      >
        <h2 className="text-foreground font-semibold px-6 pt-6 pb-4">Settings</h2>
        <div className="px-6">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2.5">Terminal</div>
          <div className="flex items-baseline justify-between mb-2">
            <label htmlFor="scroll-speed" className="text-foreground text-sm">Scroll speed</label>
            <span className="text-foreground text-sm tabular-nums">{scrollSpeed}×</span>
          </div>
          <input
            id="scroll-speed"
            type="range"
            className="w-full accent-primary"
            min={SCROLL_SPEED_MIN}
            max={SCROLL_SPEED_MAX}
            step={1}
            value={scrollSpeed}
            onChange={(e) => { update(Number(e.target.value)); }}
          />
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
            <span>{SCROLL_SPEED_MIN}× slower</span>
            <span>{SCROLL_SPEED_MAX}× faster</span>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-6 pt-5 pb-6">
          <button
            onClick={() => { update(SCROLL_SPEED_DEFAULT); }}
            className="px-1 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            Reset to default
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-primary text-primary-foreground text-sm rounded"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
