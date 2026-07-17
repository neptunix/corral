import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";

import { api } from "../lib/api";
import { parseMode, resolveTheme, STORAGE_KEY, type ResolvedTheme, type ThemeMode } from "../lib/theme";

const MEDIA = "(prefers-color-scheme: dark)";

interface ThemeValue {
  readonly mode: ThemeMode;
  readonly resolved: ResolvedTheme;
  readonly setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function prefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(MEDIA).matches
    : true; // preserve the dark default when matchMedia is unavailable
}

function readStoredMode(): ThemeMode {
  try {
    return parseMode(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return "system"; // localStorage blocked (private mode) — run non-persistent
  }
}

export function ThemeProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readStoredMode(), prefersDark()));

  // Apply the resolved theme to <html>, then enable transitions after the first paint.
  useEffect(() => {
    document.documentElement.classList.toggle("light", resolved === "light");
    const id = window.requestAnimationFrame(() => {
      document.documentElement.classList.add("transitions-ready");
    });
    return () => { window.cancelAnimationFrame(id); };
  }, [resolved]);

  // Push the resolved theme to local Claude sessions (custom:corral) whenever it CHANGES — a manual
  // toggle or an OS flip in System mode. Skips the initial mount so opening the dashboard doesn't
  // silently re-theme running sessions; best-effort, so a failed sync never affects the UI.
  const didInitialSync = useRef(false);
  useEffect(() => {
    if (!didInitialSync.current) {
      didInitialSync.current = true;
      return;
    }
    void api.theme.set(resolved).catch(() => undefined);
  }, [resolved]);

  // Re-resolve when the OS preference changes while in System mode.
  useEffect(() => {
    if (mode !== "system") {
      setResolved(mode);
      return;
    }
    if (typeof window.matchMedia !== "function") {
      setResolved(prefersDark() ? "dark" : "light"); // no matchMedia — settle on the dark default, no listener
      return;
    }
    const mql = window.matchMedia(MEDIA);
    const onChange = (): void => { setResolved(mql.matches ? "dark" : "light"); };
    onChange();
    mql.addEventListener("change", onChange);
    return () => { mql.removeEventListener("change", onChange); };
  }, [mode]);

  const setMode = useCallback((next: ThemeMode): void => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage blocked — the in-memory mode still applies for this session
    }
  }, []);

  const value = useMemo<ThemeValue>(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
