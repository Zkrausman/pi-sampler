import { createContext, type ReactNode } from "react";

type ThemeProviderProps = {
  children: ReactNode;
};

export const StitchUIThemeContext = createContext("light");

/**
 * Minimal local Stitch UI theme boundary.
 *
 * The public @stitch-ui/react package does not export a ThemeProvider, so this
 * boundary preserves the expected provider API until a compatible package is
 * selected.
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  return (
    <StitchUIThemeContext.Provider value="light">
      <div data-stitch-ui-theme="light">{children}</div>
    </StitchUIThemeContext.Provider>
  );
}
