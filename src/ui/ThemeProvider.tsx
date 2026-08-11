import {
  createContext,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from "react";

type ThemeProviderProps = {
  children: ReactNode;
};

type LayoutProps = ComponentPropsWithoutRef<"div">;

function withLayoutStyle(display: CSSProperties["display"], style?: CSSProperties): CSSProperties {
  return { display, ...style };
}

/** Minimal local Stitch UI Box compatibility primitive. */
export function Box({ children, ...props }: LayoutProps) {
  return <div {...props}>{children}</div>;
}

/** Minimal local Stitch UI Flex compatibility primitive. */
export function Flex({ children, style, ...props }: LayoutProps) {
  return <div {...props} style={withLayoutStyle("flex", style)}>{children}</div>;
}

/** Minimal local Stitch UI Grid compatibility primitive. */
export function Grid({ children, style, ...props }: LayoutProps) {
  return <div {...props} style={withLayoutStyle("grid", style)}>{children}</div>;
}

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
