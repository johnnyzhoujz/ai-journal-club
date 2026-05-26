"use client";
import { useRef, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";

const themes = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

const subscribe = () => () => {};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mountedRef = useRef(false);
  const mounted = useSyncExternalStore(
    subscribe,
    () => { mountedRef.current = true; return true; },
    () => false,
  );

  if (!mounted) return <div className="h-8 w-[104px]" />;

  return (
    <div className="flex items-center rounded-md border p-0.5 gap-0.5">
      {themes.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
          className={`inline-flex items-center justify-center rounded-sm px-2 py-1 text-sm transition-colors ${
            theme === value
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}
