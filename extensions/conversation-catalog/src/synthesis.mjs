import { generateCitedHindsightDocumentHtml } from "./evidence.mjs";

function usableSources(sources) {
  const usable = (Array.isArray(sources) ? sources : []).filter((source) => !source.excluded && source.events?.length);
  if (usable.length < 2) throw new Error("Select at least two included conversations.");
  return usable;
}

export function buildSynthesisPrompt(sources, outputPath) {
  const usable = usableSources(sources);
  const evidence = usable.flatMap((source) => source.events.map((event) => ({ reference: event.evidence.reference, context: event.summary })));
  return `Create a rigorous hindsight analysis from ONLY the redacted source bundle below. Identify cross-conversation patterns, friction/rework, recommendations, and confidence. Every material claim must cite one or more exact evidence references. Label claims as direct evidence or inference. Do not invent facts or use any content outside this bundle. Write a standalone HTML report to ${outputPath} using your write tool. Use Tokyo Night dark styling by default: page background #1a1b26, panels #24283b, text #c0caf5, muted text #a9b1d6, cyan #7dcfff, blue #7aa2f7, and orange #ff9e64; do not use light-mode colors.\n\nSOURCE BUNDLE:\n${JSON.stringify(evidence)}`;
}

export function buildHindsightDocument(sources) {
  const usable = usableSources(sources);
  const evidence = usable.flatMap((source) => source.events.map((event) => ({ reference: event.evidence.reference, context: event.summary })));
  return generateCitedHindsightDocumentHtml({ title: `Hindsight source bundle — ${usable.length} selected conversations`, claims: usable.map((source) => ({ statement: `Selected conversation contains ${source.events.length} inspectable events.`, classification: "direct evidence", evidenceReferences: [source.events[0].evidence.reference] })), evidence });
}
