import React, { useEffect } from "react";
import { useThemeMode, applyResolvedMode } from "./theme";

/**
 * Klanker monochrome theme root. The resolved mode follows useThemeMode —
 * switching Dark / White / System re-renders the tree and re-applies the
 * html dataset + meta color in one pass.
 */
export function ThemeRoot({ children }: { children: React.ReactNode }) {
  const { resolvedMode } = useThemeMode();

  useEffect(() => {
    applyResolvedMode(resolvedMode);
  }, [resolvedMode]);

  return <>{children}</>;
}
