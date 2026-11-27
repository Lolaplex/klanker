import React, { useEffect } from "react";
import { ThemeProvider } from "@openuidev/react-ui/ThemeProvider";
import { useThemeMode, applyResolvedMode, klankerOpenUiDark, klankerOpenUiLight } from "./theme";

/**
 * OpenUI ThemeProvider bound to the klanker monochrome themes
 * (klanker#170 U16). The resolved mode follows useThemeMode — switching
 * Dark / White / System re-renders the provider and re-applies the html
 * dataset + meta color in one pass.
 */
export function ThemeRoot({ children }: { children: React.ReactNode }) {
  const { resolvedMode } = useThemeMode();

  useEffect(() => {
    applyResolvedMode(resolvedMode);
  }, [resolvedMode]);

  return (
    <ThemeProvider mode={resolvedMode} darkTheme={klankerOpenUiDark} lightTheme={klankerOpenUiLight}>
      {children}
    </ThemeProvider>
  );
}
