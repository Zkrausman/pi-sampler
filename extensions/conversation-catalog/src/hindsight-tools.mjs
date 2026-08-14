/**
 * Restrict a synthesis turn to the safe report contract. The caller must restore
 * the prior session tools after the agent run has fully settled.
 */
export function restrictToolsForHindsightSynthesis(pi, activeSafeTools = ["hindsight_document_write"]) {
  const previousTools = pi.getActiveTools();
  let restored = false;

  pi.setActiveTools(Array.isArray(activeSafeTools) ? activeSafeTools : [activeSafeTools]);

  return () => {
    if (restored) return;
    restored = true;
    pi.setActiveTools(previousTools);
  };
}
