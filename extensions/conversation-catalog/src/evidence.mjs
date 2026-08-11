import { escapeHtml } from "./catalog.mjs";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function bounded(value, fallback = "No readable source context", maxLength = 480) {
  const characters = Array.from(text(value));
  if (characters.length === 0) return fallback;
  return characters.length > maxLength ? `${characters.slice(0, maxLength).join("")}…` : characters.join("");
}

function safeReference(value) {
  const reference = text(value).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  return reference || "selected-conversation";
}

function contextLink(anchor, label) {
  return `<a href="#${anchor}">${label}</a>`;
}

/**
 * Adds deterministic, local references to the already-redacted event projection.
 * References are ordinal rather than raw Pi entry IDs so a citation cannot expose
 * an opaque source identifier. Each event card remains the inspectable context.
 */
export function attachEvidenceReferences(sessionReference, projection) {
  const source = Array.isArray(projection?.events) ? projection.events : [];
  const session = safeReference(sessionReference);
  const events = source.map((event, index) => {
    const ordinal = String(index + 1).padStart(4, "0");
    return {
      ...event,
      evidence: {
        reference: `${session}:event-${ordinal}`,
        classification: "direct evidence",
        anchor: `#${text(event?.id) || `event-${index + 1}`}`,
      },
    };
  });
  return { ...projection, events };
}

/** A persistence-safe citation index: no source text or raw Pi entry IDs. */
export function createEvidenceManifest(projection) {
  const events = Array.isArray(projection?.events) ? projection.events : [];
  return {
    schemaVersion: 1,
    citations: events.flatMap((event) => {
      const evidence = event?.evidence;
      return evidence?.reference ? [{
        reference: evidence.reference,
        classification: "direct evidence",
        eventAnchor: evidence.anchor,
      }] : [];
    }),
  };
}

function normalizedRecommendations(document) {
  const recommendations = Array.isArray(document?.recommendations) ? document.recommendations : [];
  return recommendations.map((recommendation, index) => {
    const label = `Recommendation ${index + 1}`;
    const priority = text(recommendation?.priority);
    const status = text(recommendation?.status);
    const source = text(recommendation?.source);
    const dependencies = Array.isArray(recommendation?.dependencies) ? recommendation.dependencies.map(text) : [];
    const acceptanceCriteria = Array.isArray(recommendation?.acceptanceCriteria) ? recommendation.acceptanceCriteria.map(text) : [];
    const references = [...new Set((Array.isArray(recommendation?.evidenceReferences) ? recommendation.evidenceReferences : []).map(text))];
    if (!text(recommendation?.recommendation) || !["critical", "high", "medium", "low"].includes(priority)
      || !text(recommendation?.expectedImpact) || !text(recommendation?.suggestedOwner)
      || dependencies.some((dependency) => !dependency) || acceptanceCriteria.length === 0 || acceptanceCriteria.some((criterion) => !criterion)
      || status !== "proposed" || source !== "model-suggestion"
      || references.length === 0 || references.some((reference) => !reference)) {
      throw new Error(`${label} does not meet the safe structured recommendation contract.`);
    }
    return {
      recommendation: bounded(recommendation.recommendation, "", 1000),
      priority,
      expectedImpact: bounded(recommendation.expectedImpact, "", 500),
      suggestedOwner: bounded(recommendation.suggestedOwner, "", 200),
      dependencies: dependencies.map((dependency) => bounded(dependency, "", 200)),
      acceptanceCriteria: acceptanceCriteria.map((criterion) => bounded(criterion, "", 500)),
      status,
      source,
      references,
    };
  });
}

function normalizedClaimSupportValidation(document, claims) {
  const validation = document?.claimSupportValidation;
  if (validation === undefined) return undefined;
  if (!validation || typeof validation !== "object" || Array.isArray(validation)
    || text(validation.source) !== "model-validation" || text(validation.userDisposition) !== "not-user-confirmed") {
    throw new Error("Claim-support validation must be model-generated and not user-confirmed.");
  }
  const assessments = validation.assessments;
  if (!Array.isArray(assessments) || assessments.length !== claims.length) {
    throw new Error("Claim-support validation must assess every material claim exactly once.");
  }
  const claimNumbers = new Set();
  return assessments.map((assessment, index) => {
    const label = `Claim-support assessment ${index + 1}`;
    const claimNumber = assessment?.claimNumber;
    if (!Number.isInteger(claimNumber) || claimNumber < 1 || claimNumber > claims.length || claimNumbers.has(claimNumber)) {
      throw new Error("Claim-support validation must assess every material claim exactly once.");
    }
    claimNumbers.add(claimNumber);
    const support = text(assessment?.support);
    if (!["supported", "partially supported", "unsupported", "unverifiable"].includes(support)) {
      throw new Error(`${label} has an invalid support classification.`);
    }
    const references = [...new Set((Array.isArray(assessment?.evidenceReferences) ? assessment.evidenceReferences : []).map(text))];
    const claimReferences = claims[claimNumber - 1].references;
    if (references.length !== claimReferences.length || references.some((reference) => !reference) || claimReferences.some((reference) => !references.includes(reference))) {
      throw new Error(`${label} must evaluate exactly the claim's cited redacted evidence excerpts.`);
    }
    return { claimNumber, support, references };
  });
}

/**
 * Renders a saved/exportable hindsight document from explicit claims and a
 * redacted evidence snapshot. Every claim and recommendation citation links to
 * its embedded source context and, when supplied, flow/map context.
 */
export function generateCitedHindsightDocumentHtml(document) {
  const claims = Array.isArray(document?.claims) ? document.claims : [];
  const suppliedEvidence = Array.isArray(document?.evidence) ? document.evidence : [];
  const evidenceByReference = new Map();
  const excludedReferences = new Set(Array.isArray(document?.excludedEvidenceReferences) ? document.excludedEvidenceReferences.map(text) : []);
  for (const item of suppliedEvidence) {
    const reference = text(item?.reference);
    if (!reference || evidenceByReference.has(reference)) throw new Error("Evidence references must be unique and non-empty.");
    evidenceByReference.set(reference, item);
  }

  const normalizedClaims = claims.map((claim, index) => {
    const statement = bounded(claim?.statement, "No readable claim");
    const classification = text(claim?.classification);
    if (classification !== "direct evidence" && classification !== "inference") {
      throw new Error(`Claim ${index + 1} must be explicitly classified as direct evidence or inference.`);
    }
    const references = [...new Set((Array.isArray(claim?.evidenceReferences) ? claim.evidenceReferences : []).map(text))];
    if (references.length === 0 || references.some((reference) => !reference)) {
      throw new Error(`Claim ${index + 1} has no inspectable source evidence.`);
    }
    return { statement, classification, references };
  });
  const recommendations = normalizedRecommendations(document);
  const claimSupportValidation = normalizedClaimSupportValidation(document, normalizedClaims);

  // Missing references retain a navigable, explicit fallback rather than a dead link.
  const referenced = [...new Set([
    ...normalizedClaims.flatMap((claim) => claim.references),
    ...recommendations.flatMap((recommendation) => recommendation.references),
  ])];
  const evidence = referenced.map((reference) => {
    const supplied = evidenceByReference.get(reference);
    if (supplied) return { ...supplied, reference, availability: text(supplied.availability) || "included" };
    return { reference, availability: excludedReferences.has(reference) ? "excluded" : "missing" };
  }).concat([...evidenceByReference.entries()]
    .filter(([reference]) => !referenced.includes(reference))
    .map(([reference, item]) => ({ ...item, reference, availability: text(item.availability) || "included" })));
  const citationAnchors = new Map(evidence.map((item, index) => [item.reference, `citation-${index + 1}`]));
  const citationLinks = (references) => references.map((reference) => {
    const item = evidence.find((candidate) => candidate.reference === reference);
    const anchor = citationAnchors.get(reference);
    const links = [contextLink(anchor, escapeHtml(reference))];
    if (text(item?.flowContext)) links.push(contextLink(`${anchor}-flow`, "flow"));
    if (text(item?.mapContext)) links.push(contextLink(`${anchor}-map`, "map"));
    return links.join(" · ");
  }).join(", ");

  const claimHtml = normalizedClaims.length === 0
    ? '<p class="empty">No material claims were supplied.</p>'
    : normalizedClaims.map((claim) => `<article class="claim claim-${claim.classification.replace(/\s+/g, "-")}">
      <p class="classification">${escapeHtml(claim.classification)}</p><p>${escapeHtml(claim.statement)}</p>
      <p class="citations">Evidence: ${citationLinks(claim.references)}</p>
    </article>`).join("\n");
  const list = (items, empty) => items.length === 0
    ? `<span class="empty">${escapeHtml(empty)}</span>`
    : `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  const recommendationHtml = recommendations.length === 0
    ? '<p class="empty" role="status">No structured recommendations were supplied. Review the cited claims and source context before deciding on follow-up work.</p>'
    : `<div class="table-scroll" tabindex="0" aria-label="Scrollable recommendation table"><table><caption>Structured recommendations proposed by the model; none are user-confirmed.</caption><thead><tr><th scope="col">Recommendation</th><th scope="col">Priority</th><th scope="col">Expected impact</th><th scope="col">Suggested owner</th><th scope="col">Dependencies</th><th scope="col">Measurable acceptance criteria</th><th scope="col">Status and source</th><th scope="col">Evidence</th></tr></thead><tbody>${recommendations.map((recommendation) => `<tr><th scope="row">${escapeHtml(recommendation.recommendation)}</th><td>${escapeHtml(recommendation.priority)}</td><td>${escapeHtml(recommendation.expectedImpact)}</td><td>${escapeHtml(recommendation.suggestedOwner)}</td><td>${list(recommendation.dependencies, "No dependencies specified")}</td><td>${list(recommendation.acceptanceCriteria, "No acceptance criteria supplied")}</td><td><span class="provenance">${escapeHtml(recommendation.status)} · ${escapeHtml(recommendation.source)}</span><br><span class="empty">Not user-confirmed</span></td><td class="citations">${citationLinks(recommendation.references)}</td></tr>`).join("\n")}</tbody></table></div>`;
  const claimSupportHtml = !claimSupportValidation
    ? '<p class="empty" role="status">Claim-support validation was not requested.</p>'
    : `<p class="empty">Model-generated validation only; it is not a user-confirmed disposition.</p><ol class="claim-support-list">${claimSupportValidation.map((assessment) => `<li><strong>Claim ${assessment.claimNumber}:</strong> <span class="provenance">${escapeHtml(assessment.support)}</span><br><span class="empty">Evidence evaluated:</span> <span class="citations">${citationLinks(assessment.references)}</span></li>`).join("")}</ol>`;
  const evidenceHtml = evidence.length === 0
    ? '<p class="empty">No evidence snapshot was supplied.</p>'
    : evidence.map((item) => {
      const reference = text(item.reference);
      const anchor = citationAnchors.get(reference);
      const availability = text(item.availability);
      if (availability === "excluded" || availability === "missing") {
        const message = availability === "excluded"
          ? "Source context was excluded during redaction review."
          : "Source context is unavailable in this report.";
        return `<article id="${anchor}" class="evidence evidence-unavailable"><h3>${escapeHtml(reference)}</h3>
          <p class="classification">${escapeHtml(availability)} source</p><p class="context">${message}</p>
          <p class="context-fallback">Flow and relationship-map context are unavailable.</p></article>`;
      }
      const flowContext = text(item.flowContext);
      const mapContext = text(item.mapContext);
      return `<article id="${anchor}" class="evidence"><h3>${escapeHtml(reference)}</h3>
        <p class="classification">direct evidence</p><h4>Redacted source context</h4><p class="context">${escapeHtml(bounded(item.context))}</p>
        <section id="${anchor}-flow" class="context-panel"><h4>Flow context</h4><p class="context">${escapeHtml(flowContext ? bounded(flowContext) : "No flow context was supplied.")}</p></section>
        <section id="${anchor}-map" class="context-panel"><h4>Relationship-map context</h4><p class="context">${escapeHtml(mapContext ? bounded(mapContext) : "No relationship-map context was supplied.")}</p></section>
      </article>`;
    }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pi hindsight document</title><style>:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#1a1b26;color:#c0caf5}body{margin:0 auto;max-width:80rem;padding:2rem;line-height:1.45}.claim,.evidence,.claim-support-list li{background:#24283b;border:1px solid #414868;border-radius:.5rem;margin:1rem 0;padding:1rem}.claim-inference{border-left:.5rem solid #a66b12}.claim-direct-evidence{border-left:.5rem solid #2c78c4}.classification,.provenance{font-size:.85rem;font-weight:700;text-transform:capitalize}.citations a{font-weight:700}.context{white-space:pre-wrap;overflow-wrap:anywhere}.context-panel{border-top:1px dashed #414868;margin-top:.9rem;padding-top:.2rem;scroll-margin-top:1rem}.context-panel h4,.evidence h4{margin-bottom:.25rem}.evidence-unavailable{border-left:.5rem solid #a66b12}.context-fallback,.empty{color:#a9b1d6}.claim-support-list{list-style-position:inside;padding:0}.table-scroll{overflow-x:auto;margin:1rem 0}.table-scroll:focus{outline:2px solid #7aa2f7;outline-offset:2px}table{border-collapse:collapse;min-width:72rem;width:100%;background:#24283b}caption{text-align:left;font-weight:700;padding:.5rem 0}th,td{border:1px solid #414868;padding:.7rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}thead th{background:#2f354d}tbody th{min-width:14rem}td ul{margin:.1rem 0;padding-left:1.2rem}</style></head><body><h1>${escapeHtml(bounded(document?.title, "Pi hindsight document", 160))}</h1><p>Claims label direct evidence separately from model-generated inference. Every material claim and recommendation links to embedded redacted source context, with flow and relationship-map context where available.</p><main><section aria-labelledby="claims-heading"><h2 id="claims-heading">Claims</h2>${claimHtml}</section><section aria-labelledby="claim-support-heading"><h2 id="claim-support-heading">Claim-support validation</h2>${claimSupportHtml}</section><section aria-labelledby="recommendations-heading"><h2 id="recommendations-heading">Recommendations</h2>${recommendationHtml}</section></main><section><h2>Evidence</h2>${evidenceHtml}</section></body></html>`;
}
