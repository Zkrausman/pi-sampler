import { generateCitedHindsightDocumentHtml } from "./evidence.mjs";

const text = (value) => typeof value === "string" ? value.trim() : "";

function usableSources(sources) {
  const usable = (Array.isArray(sources) ? sources : []).filter((source) => !source.excluded && source.events?.length);
  if (usable.length < 2) throw new Error("Select at least two included conversations.");
  return usable;
}

function describeFlow(event) {
  return [text(event?.category) || "Event", text(event?.timestamp), text(event?.title), text(event?.summary)]
    .filter(Boolean).join(" · ");
}

function mapContexts(source) {
  const events = Array.isArray(source?.events) ? source.events : [];
  const references = new Map(events.map((event) => [event?.id, text(event?.evidence?.reference)]));
  const contexts = new Map();
  for (const edge of Array.isArray(source?.edges) ? source.edges : []) {
    const from = references.get(edge?.from);
    const to = references.get(edge?.to);
    if (!from || !to) continue;
    const label = text(edge?.label) || "related";
    const outgoing = `${label} → ${to}`;
    const incoming = `${label} ← ${from}`;
    contexts.set(from, [...(contexts.get(from) || []), outgoing]);
    contexts.set(to, [...(contexts.get(to) || []), incoming]);
  }
  return contexts;
}

function sourceEvidence(sources) {
  return sources.flatMap((source) => {
    const relationships = mapContexts(source);
    return source.events.map((event) => ({
      reference: event.evidence.reference,
      context: event.summary,
      flowContext: describeFlow(event),
      mapContext: (relationships.get(text(event.evidence?.reference)) || []).join("\n"),
    }));
  });
}

export function buildSynthesisPrompt(sources, outputPath) {
  const usable = usableSources(sources);
  const evidence = sourceEvidence(usable);
  return `Create a rigorous hindsight analysis from ONLY the redacted source bundle below. Identify cross-conversation patterns, friction/rework, recommendations, and confidence. Every material claim must cite one or more exact evidence references and be labeled direct evidence or inference. Do not invent facts or use any content outside this bundle. Write a standalone HTML report to ${outputPath} using your write tool. Use Tokyo Night dark styling by default: page background #1a1b26, panels #24283b, text #c0caf5, muted text #a9b1d6, cyan #7dcfff, blue #7aa2f7, and orange #ff9e64; do not use light-mode colors.

The report MUST make each citation navigable: every cited reference links to an embedded evidence section whose id is a safe ordinal (for example citation-1), not the reference itself. Each evidence section must show its redacted source context. When an evidence item includes flowContext or mapContext, embed those contexts in separately anchored subsections and link to them beside the source citation. If a source is missing or excluded, retain a citation anchor with a visible "Source context unavailable" or "Source context excluded during redaction review" fallback; never substitute unredacted content or raw session/event identifiers.

REDACTED SOURCE BUNDLE:
${JSON.stringify(evidence)}`;
}

export function buildHindsightDocument(sources) {
  const usable = usableSources(sources);
  const evidence = sourceEvidence(usable);
  return generateCitedHindsightDocumentHtml({
    title: `Hindsight source bundle — ${usable.length} selected conversations`,
    claims: usable.map((source) => ({
      statement: `Selected conversation contains ${source.events.length} inspectable events.`,
      classification: "direct evidence",
      evidenceReferences: [source.events[0].evidence.reference],
    })),
    evidence,
  });
}
