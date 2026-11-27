import { useCallback, useEffect, useState } from "react";
import { createTheme } from "@openuidev/react-ui/ThemeProvider";
import type { Theme } from "@openuidev/react-ui/ThemeProvider";

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

// --- OpenUI theme overrides: strict klanker monochrome, zero blue/purple --

const monoDark: Theme = createTheme({
  background: "#000000",
  foreground: "#ffffff",
  popoverBackground: "#0a0a0a",
  sunk: "#0a0a0a",
  sunkLight: "#0a0a0a",
  sunkDeep: "#000000",
  elevated: "#141414",
  elevatedLight: "#1a1a1a",
  elevatedStrong: "#1f1f1f",
  elevatedIntense: "#262626",
  overlay: "rgba(0, 0, 0, 0.7)",
  highlightSubtle: "#1a1a1a",
  highlight: "#262626",
  highlightStrong: "#333333",
  highlightIntense: "#404040",
  invertedBackground: "#ffffff",
  textNeutralPrimary: "#ffffff",
  textNeutralSecondary: "#a3a3a3",
  textNeutralTertiary: "#737373",
  textNeutralLink: "#ffffff",
  textBrand: "#ffffff",
  textWhite: "#ffffff",
  textBlack: "#000000",
  textAccentPrimary: "#ffffff",
  textAccentSecondary: "#e5e5e5",
  textAccentTertiary: "#a3a3a3",
  interactiveAccentDefault: "#ffffff",
  interactiveAccentHover: "#e5e5e5",
  interactiveAccentPressed: "#d4d4d4",
  interactiveAccentDisabled: "#404040",
  borderDefault: "#262626",
  borderInteractive: "#333333",
  borderInteractiveEmphasis: "#525252",
  borderInteractiveSelected: "#ffffff",
  borderAccent: "#ffffff",
  borderAccentEmphasis: "#ffffff",
});

const monoLight: Theme = createTheme({
  background: "#ffffff",
  foreground: "#000000",
  popoverBackground: "#f7f7f7",
  sunk: "#f7f7f7",
  sunkLight: "#f7f7f7",
  sunkDeep: "#efefef",
  elevated: "#efefef",
  elevatedLight: "#e5e5e5",
  elevatedStrong: "#e5e5e5",
  elevatedIntense: "#d4d4d4",
  overlay: "rgba(255, 255, 255, 0.7)",
  highlightSubtle: "#e5e5e5",
  highlight: "#d4d4d4",
  highlightStrong: "#c8c8c8",
  highlightIntense: "#a3a3a3",
  invertedBackground: "#000000",
  textNeutralPrimary: "#000000",
  textNeutralSecondary: "#525252",
  textNeutralTertiary: "#737373",
  textNeutralLink: "#000000",
  textBrand: "#000000",
  textWhite: "#ffffff",
  textBlack: "#000000",
  textAccentPrimary: "#000000",
  textAccentSecondary: "#262626",
  textAccentTertiary: "#525252",
  interactiveAccentDefault: "#000000",
  interactiveAccentHover: "#333333",
  interactiveAccentPressed: "#525252",
  interactiveAccentDisabled: "#c8c8c8",
  borderDefault: "#e5e5e5",
  borderInteractive: "#c8c8c8",
  borderInteractiveEmphasis: "#a3a3a3",
  borderInteractiveSelected: "#000000",
  borderAccent: "#000000",
  borderAccentEmphasis: "#000000",
});

export const klankerOpenUiDark = monoDark;
export const klankerOpenUiLight = monoLight;
