import { useEffect, useRef, useState } from "react";
import { Box, Flex, Grid } from "../ui/ThemeProvider";
import {
  COLOR_PALETTE,
  COPIED_FEEDBACK_DURATION_MS,
  INITIAL_COPY_FEEDBACK_STATE,
  clearCopiedColor,
  copyHexColor,
  markColorCopied,
  markColorCopyFailed,
} from "./colorPaletteState";
import "./ColorPalette.css";

export function ColorPalette() {
  const [copyFeedback, setCopyFeedback] = useState(INITIAL_COPY_FEEDBACK_STATE);
  const feedbackTokenRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
  }, []);

  function showCopyFeedback(color: string, didCopySucceed: boolean) {
    const currentFeedback = { color: null, status: null, token: feedbackTokenRef.current } as const;
    const nextFeedback = didCopySucceed
      ? markColorCopied(currentFeedback, color)
      : markColorCopyFailed(currentFeedback, color);
    feedbackTokenRef.current = nextFeedback.token;
    setCopyFeedback(nextFeedback);

    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setCopyFeedback((current) => clearCopiedColor(current, nextFeedback.token));
      timeoutRef.current = null;
    }, COPIED_FEEDBACK_DURATION_MS);
  }

  async function handleCopy(color: string) {
    try {
      await copyHexColor(color);
      showCopyFeedback(color, true);
    } catch {
      showCopyFeedback(color, false);
    }
  }

  return (
    <Box className="color-palette" aria-labelledby="color-palette-title">
      <Flex className="color-palette__heading" style={{ alignItems: "baseline", justifyContent: "space-between" }}>
        <Box>
          <h1 id="color-palette-title">Color palette</h1>
          <p>Eight harmonious colors ready to copy.</p>
        </Box>
      </Flex>
      <Grid className="color-palette__grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        {COLOR_PALETTE.map((color) => {
          const isCopied = copyFeedback.color === color && copyFeedback.status === "copied";
          const copyFailed = copyFeedback.color === color && copyFeedback.status === "failed";
          return (
            <Box className="color-palette__swatch" key={color}>
              <button
                aria-label={isCopied ? `${color} copied` : copyFailed ? `${color} copy failed` : `Copy ${color}`}
                className={`color-palette__button${copyFailed ? " color-palette__button--copy-failed" : ""}`}
                onClick={() => void handleCopy(color)}
                type="button"
              >
                <Box className="color-palette__color" style={{ backgroundColor: color }} aria-hidden="true" />
                <Flex className="color-palette__label" style={{ alignItems: "center", justifyContent: "space-between" }}>
                  <span>{color}</span>
                  <span className="color-palette__feedback" aria-live="polite">
                    {isCopied ? "Copied!" : copyFailed ? "Copy failed" : "Copy"}
                  </span>
                </Flex>
              </button>
            </Box>
          );
        })}
      </Grid>
    </Box>
  );
}
