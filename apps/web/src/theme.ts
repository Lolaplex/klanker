import { useCallback, useEffect, useState } from "react";

// Theme mode (klanker#170 U16): "dark" is the klanker default, "light" is
// the inverted white mode, "system" follows the OS. Persisted to
// localStorage["klanker.theme"], applied onto <html data-theme>, the
// dark/light class and the theme-color meta.

export type ThemeModePreference = "dark" | "light" | "system";
export type ResolvedThemeMode = "dark" | "light";

const LS_KEY = "klanker.theme";

export function readThemePreference(): ThemeModePreference {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {}
  return "dark";
}

export function systemMode(): ResolvedThemeMode {
  try {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function resolveMode(pref: ThemeModePreference): ResolvedThemeMode {
  return pref === "system" ? systemMode() : pref;
}

/** Apply the resolved mode to <html> + theme-color meta. Exported so the
 *  anti-flash bootstrap in index.html/main.tsx and tests share one path. */
export function applyResolvedMode(mode: ResolvedThemeMode): void {
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.classList.remove("dark", "light");
  root.classList.add(mode);
  let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = mode === "light" ? "#ffffff" : "#000000";
}

const listeners = new Set<() => void>();

export function setThemePreference(pref: ThemeModePreference): void {
  try {
    localStorage.setItem(LS_KEY, pref);
  } catch {}
  applyResolvedMode(resolveMode(pref));
  listeners.forEach((fn) => fn());
}

/** React hook: current preference + resolved mode, live across OS flips
 *  and cross-component writes. */
export function useThemeMode(): {
  preference: ThemeModePreference;
  resolvedMode: ResolvedThemeMode;
  setPreference: (p: ThemeModePreference) => void;
} {
  const [preference, setPref] = useState<ThemeModePreference>(() => readThemePreference());
  const [resolved, setResolved] = useState<ResolvedThemeMode>(() => resolveMode(readThemePreference()));

  useEffect(() => {
    const sync = () => {
      const p = readThemePreference();
      setPref(p);
      setResolved(resolveMode(p));
    };
    listeners.add(sync);
    const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
    const onOs = () => {
      if (readThemePreference() === "system") sync();
    };
    mq?.addEventListener?.("change", onOs);
    return () => {
      listeners.delete(sync);
      mq?.removeEventListener?.("change", onOs);
    };
  }, []);

  const setPreference = useCallback((p: ThemeModePreference) => setThemePreference(p), []);
  return { preference, resolvedMode: resolved, setPreference };
}

/** Bootstrap before React mounts — kills the flash of the wrong theme. */
export function bootstrapTheme(): void {
  applyResolvedMode(resolveMode(readThemePreference()));
}
