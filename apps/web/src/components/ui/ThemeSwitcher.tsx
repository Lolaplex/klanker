import { Moon, Sun, MonitorCog } from "lucide-react";
import { useThemeMode, type ThemeModePreference } from "../../theme";

const OPTIONS: { value: ThemeModePreference; label: string; Icon: typeof Moon }[] = [
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "light", label: "White", Icon: Sun },
  { value: "system", label: "System", Icon: MonitorCog },
];

/**
 * Accessible theme switcher (klanker#170 U16): Dark / White / System as a
 * radiogroup of monochrome pills. The active pill inverts (accent bg,
 * accent-ink fg) in both modes.
 */
export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { preference, setPreference } = useThemeMode();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 bg-transparent border border-subtle rounded-md p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${label} theme`}
            title={`${label} theme`}
            onClick={() => setPreference(value)}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] transition-colors ${
              active
                ? "bg-accent text-accent-ink"
                : "text-ink-secondary hover:text-ink-primary hover:bg-hover"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {!compact && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
