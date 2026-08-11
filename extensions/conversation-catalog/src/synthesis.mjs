import { generateCitedHindsightDocumentHtml } from "./evidence.mjs";

const text = (value) => typeof value === "string" ? value.trim() : "";

function selectedSources(sources) {
  const selected = (Array.isArray(sources) ? sources : []).filter((source) => source && (source.excluded || Array.isArray(source.events)));
  if (selected.length < 2) throw new Error("Select at least two conversations.");
  return selected;
}

function sourceReference(source, index) {
  return text(source?.reference) || `selected-conversation-${index + 1}`;
}

function excludedReference(source, index) {
  return `${sourceReference(source, index)}:excluded`;
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
  return sources.flatMap((source, index) => {
    if (source.excluded) return [{ reference: excludedReference(source, index), availability: "excluded" }];
    const relationships = mapContexts(source);
    return (Array.isArray(source.events) ? source.events : []).flatMap((event) => {
      const reference = text(event?.evidence?.reference);
      return reference ? [{
        reference,
        context: event.summary,
        flowContext: describeFlow(event),
        mapContext: (relationships.get(reference) || []).join("\n"),
      }] : [];
    });
  });
}

function fallbackClaims(sources) {
  return sources.flatMap((source, index) => source.excluded ? [{
    statement: "A selected conversation was excluded during redaction review.",
    classification: "direct evidence",
    evidenceReferences: [excludedReference(source, index)],
  }] : []);
}

function validateClaims(claims, allowedReferences) {
  const requested = Array.isArray(claims) ? claims : [];
  for (const [index, claim] of requested.entries()) {
    const references = Array.isArray(claim?.evidenceReferences) ? claim.evidenceReferences.map(text) : [];
    if (references.some((reference) => !allowedReferences.has(reference))) {
      throw new Error(`Claim ${index + 1} cites evidence outside the selected redacted source bundle.`);
    }
  }
  return requested;
}

function defaultClaims(sources) {
  return sources.flatMap((source) => {
    if (source.excluded || !Array.isArray(source.events) || source.events.length === 0) return [];
    const reference = text(source.events[0]?.evidence?.reference);
    return reference ? [{
      statement: `Selected conversation contains ${source.events.length} inspectable events.`,
      classification: "direct evidence",
      evidenceReferences: [reference],
    }] : [];
  });
}

/**
 * Creates the only report HTML contract used by hindsight generation. Model
 * prose is accepted as structured claims, then escaped and linked here rather
 * than allowing the model to write report markup directly.
 */
export function buildHindsightDocument(sources, modelOutput = undefined) {
  const selected = selectedSources(sources);
  const evidence = sourceEvidence(selected);
  const allowedReferences = new Set(evidence.filter((item) => item.availability !== "excluded").map((item) => item.reference));
  const modelClaims = modelOutput === undefined ? defaultClaims(selected) : validateClaims(modelOutput?.claims, allowedReferences);
  return generateCitedHindsightDocumentHtml({
    title: text(modelOutput?.title) || `Hindsight source bundle — ${selected.length} selected conversations`,
    claims: [...modelClaims, ...fallbackClaims(selected)],
    evidence,
  });
}

export function buildSynthesisPrompt(sources) {
  const selected = selectedSources(sources);
  const evidence = sourceEvidence(selected);
  const includedEvidence = evidence.filter((item) => item.availability !== "excluded");
  const excludedEvidence = evidence.filter((item) => item.availability === "excluded").map((item) => item.reference);
  return `Create a rigorous hindsight analysis from ONLY the redacted source bundle below. Identify cross-conversation patterns, friction/rework, recommendations, and confidence. Every material claim must cite one or more exact included evidence references and be labeled direct evidence or inference. Do not invent facts or use any content outside this bundle.

Do NOT write HTML or use a file-writing tool. Call hindsight_document_write exactly once with a short title and structured claims. That tool is the report contract: it escapes model text and generates all citation anchors, redacted source sections, flow/map context, and excluded-source fallbacks in the requested standalone HTML output. Do not cite an excluded reference for a substantive claim; the contract records its redaction-review fallback itself.

REDACTED SOURCE BUNDLE:
${JSON.stringify(includedEvidence)}

EXCLUDED SELECTION REFERENCES (do not use for substantive claims):
${JSON.stringify(excludedEvidence)}`;
}
