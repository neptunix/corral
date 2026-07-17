import type { JSX } from "react";

import { MoonIcon, SunIcon, SystemIcon } from "./icons/themeIcons";
import { useTheme } from "./ThemeProvider";
import type { ThemeMode } from "../lib/theme";

interface Option {
  readonly mode: ThemeMode;
  readonly label: string;
  readonly Icon: (props: { readonly className?: string }) => JSX.Element;
}

const OPTIONS: readonly Option[] = [
  { mode: "light", label: "Light", Icon: SunIcon },
  { mode: "dark", label: "Dark", Icon: MoonIcon },
  { mode: "system", label: "System", Icon: SystemIcon },
];

export function ThemeSwitch(): JSX.Element {
  const { mode, setMode } = useTheme();
  return (
    <div className="flex gap-1" role="group" aria-label="Theme">
      {OPTIONS.map(({ mode: m, label, Icon }) => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); }}
            aria-pressed={active}
            aria-label={label}
            title={label}
            className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
              active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="w-4 h-4" />
          </button>
        );
      })}
    </div>
  );
}
