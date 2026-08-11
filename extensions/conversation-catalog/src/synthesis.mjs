import { generateCitedHindsightDocumentHtml } from "./evidence.mjs";

const text = (value) => typeof value === "string" ? value.trim() : "";
const MODEL_LIMITS = Object.freeze({
  title: 160,
  claim: 2000,
  reference: 100,
  recommendation: 1000,
  impact: 500,
  owner: 200,
  dependency: 200,
  acceptanceCriterion: 500,
});

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

function requiredModelText(value, field, maxLength) {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  const length = Array.from(trimmed).length;
  if (length === 0) throw new Error(`${field} must not be blank.`);
  if (length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters.`);
  return trimmed;
}

function optionalModelText(value, field, maxLength) {
  return value === undefined ? undefined : requiredModelText(value, field, maxLength);
}

function modelArray(value, field, { minItems = 0, maxItems }) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  if (value.length < minItems || value.length > maxItems) {
    throw new Error(`${field} must contain between ${minItems} and ${maxItems} item${maxItems === 1 ? "" : "s"}.`);
  }
  return value;
}

function evidenceReferences(value, field, allowedReferences) {
  const references = modelArray(value, field, { minItems: 1, maxItems: 20 })
    .map((reference, index) => requiredModelText(reference, `${field}[${index + 1}]`, MODEL_LIMITS.reference));
  if (new Set(references).size !== references.length) throw new Error(`${field} must not contain duplicate references.`);
  if (references.some((reference) => !allowedReferences.has(reference))) {
    throw new Error(`${field} cites evidence outside the selected redacted source bundle.`);
  }
  return references;
}

function validateClaims(claims, allowedReferences) {
  return modelArray(claims, "claims", { maxItems: 80 }).map((claim, index) => {
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) throw new Error(`Claim ${index + 1} must be an object.`);
    const classification = requiredModelText(claim.classification, `Claim ${index + 1} classification`, 32);
    if (classification !== "direct evidence" && classification !== "inference") {
      throw new Error(`Claim ${index + 1} must be explicitly classified as direct evidence or inference.`);
    }
    return {
      statement: requiredModelText(claim.statement, `Claim ${index + 1} statement`, MODEL_LIMITS.claim),
      classification,
      evidenceReferences: evidenceReferences(claim.evidenceReferences, `Claim ${index + 1} evidenceReferences`, allowedReferences),
    };
  });
}

function validateRecommendations(recommendations, allowedReferences) {
  return modelArray(recommendations, "recommendations", { maxItems: 40 }).map((recommendation, index) => {
    const label = `Recommendation ${index + 1}`;
    if (!recommendation || typeof recommendation !== "object" || Array.isArray(recommendation)) throw new Error(`${label} must be an object.`);
    const priority = requiredModelText(recommendation.priority, `${label} priority`, 16);
    if (!["critical", "high", "medium", "low"].includes(priority)) {
      throw new Error(`${label} priority must be critical, high, medium, or low.`);
    }
    const status = requiredModelText(recommendation.status, `${label} status`, 32);
    const source = requiredModelText(recommendation.source, `${label} source`, 32);
    // The model is never allowed to represent a suggestion as user confirmation.
    if (status !== "proposed" || source !== "model-suggestion") {
      throw new Error(`${label} must have status "proposed" and source "model-suggestion".`);
    }
    return {
      recommendation: requiredModelText(recommendation.recommendation, `${label} recommendation`, MODEL_LIMITS.recommendation),
      priority,
      expectedImpact: requiredModelText(recommendation.expectedImpact, `${label} expectedImpact`, MODEL_LIMITS.impact),
      suggestedOwner: requiredModelText(recommendation.suggestedOwner, `${label} suggestedOwner`, MODEL_LIMITS.owner),
      dependencies: modelArray(recommendation.dependencies, `${label} dependencies`, { maxItems: 20 })
        .map((dependency, dependencyIndex) => requiredModelText(dependency, `${label} dependencies[${dependencyIndex + 1}]`, MODEL_LIMITS.dependency)),
      acceptanceCriteria: modelArray(recommendation.acceptanceCriteria, `${label} acceptanceCriteria`, { minItems: 1, maxItems: 20 })
        .map((criterion, criterionIndex) => requiredModelText(criterion, `${label} acceptanceCriteria[${criterionIndex + 1}]`, MODEL_LIMITS.acceptanceCriterion)),
      status,
      source,
      evidenceReferences: evidenceReferences(recommendation.evidenceReferences, `${label} evidenceReferences`, allowedReferences),
    };
  });
}

function validateModelOutput(modelOutput, allowedReferences) {
  if (!modelOutput || typeof modelOutput !== "object" || Array.isArray(modelOutput)) throw new Error("Hindsight model output must be an object.");
  return {
    title: optionalModelText(modelOutput.title, "title", MODEL_LIMITS.title),
    claims: validateClaims(modelOutput.claims, allowedReferences),
    recommendations: validateRecommendations(modelOutput.recommendations, allowedReferences),
  };
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
 * prose is accepted as strictly validated structured claims and recommendations,
 * then escaped and linked here rather than allowing the model to write markup.
 */
export function buildHindsightDocument(sources, modelOutput = undefined) {
  const selected = selectedSources(sources);
  const evidence = sourceEvidence(selected);
  const allowedReferences = new Set(evidence.filter((item) => item.availability !== "excluded").map((item) => item.reference));
  const model = modelOutput === undefined
    ? { claims: defaultClaims(selected), recommendations: [] }
    : validateModelOutput(modelOutput, allowedReferences);
  return generateCitedHindsightDocumentHtml({
    title: model.title || `Hindsight source bundle — ${selected.length} selected conversations`,
    claims: [...model.claims, ...fallbackClaims(selected)],
    recommendations: model.recommendations,
    evidence,
  });
}

export function buildSynthesisPrompt(sources) {
  const selected = selectedSources(sources);
  const evidence = sourceEvidence(selected);
  const includedEvidence = evidence.filter((item) => item.availability !== "excluded");
  const excludedEvidence = evidence.filter((item) => item.availability === "excluded").map((item) => item.reference);
  return `Create a rigorous hindsight analysis from ONLY the redacted source bundle below. Identify cross-conversation patterns, friction/rework, recommendations, and confidence. Every material claim and recommendation must cite one or more exact included evidence references and be labeled direct evidence or inference where applicable. Do not invent facts or use any content outside this bundle.

Do NOT write HTML or use a file-writing tool. Call hindsight_document_write exactly once with a short title, structured claims, and structured recommendations. Every recommendation must include: recommendation, priority (critical, high, medium, or low), expectedImpact, suggestedOwner, dependencies (an array, which may be empty), acceptanceCriteria (one or more measurable criteria), status "proposed", source "model-suggestion", and evidenceReferences. Status and source are fixed: a model must never claim that a user confirmed an owner, dependency, or recommendation. Owner and dependency text must be derived only from this reviewed, redacted source bundle. The tool rejects malformed recommendations rather than filling in missing values. It escapes model text and generates all citation anchors, redacted source sections, flow/map context, and excluded-source fallbacks in the requested standalone HTML output. Do not cite an excluded reference for a substantive claim or recommendation; the contract records its redaction-review fallback itself.

REDACTED SOURCE BUNDLE:
${JSON.stringify(includedEvidence)}

EXCLUDED SELECTION REFERENCES (do not use for substantive claims or recommendations):
${JSON.stringify(excludedEvidence)}`;
}
