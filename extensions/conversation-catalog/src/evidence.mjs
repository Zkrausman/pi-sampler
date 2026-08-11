import { escapeHtml } from "./catalog.mjs";
import { renderHindsightOutcomeHistoryHtml } from "./hindsight-outcomes.mjs";
import { createHindsightFeedbackMetadata, renderHindsightFeedbackHtml } from "./hindsight-feedback.mjs";

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

function normalizedReportIdentityClaims(document) {
  const claims = Array.isArray(document?.claims) ? document.claims : [];
  return claims.map((claim, index) => {
    const statement = bounded(claim?.statement, "", 2000);
    const classification = text(claim?.classification);
    const references = [...new Set((Array.isArray(claim?.evidenceReferences) ? claim.evidenceReferences : claim?.references || []).map(text))];
    if (!statement || !["direct evidence", "inference"].includes(classification) || references.length === 0 || references.some((reference) => !reference)) {
      throw new Error(`Claim ${index + 1} does not meet the report identity contract.`);
    }
    return { statement, classification, references, validationExcluded: claim?.validationExcluded === true };
  });
}

function requiredStoryText(value, field, maxLength) {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (length === 0 || length > maxLength) throw new Error(`${field} must be between 1 and ${maxLength} characters.`);
  return normalized;
}

// Story steps have a stricter runtime contract than generic claims: they are
// model-proposed navigation through the supplied redacted bundle, never a
// channel for unavailable fallbacks or separately supplied user context.
function normalizedStorySteps(document, evidenceByReference) {
  if (document?.storySteps === undefined) return [];
  if (!Array.isArray(document.storySteps) || document.storySteps.length > 30) {
    throw new Error("storySteps must be an array containing at most 30 steps.");
  }
  const identities = new Set();
  return document.storySteps.map((step, index) => {
    const label = `Story step ${index + 1}`;
    if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`${label} must be an object.`);
    const keys = Object.keys(step);
    if (keys.length !== 4 || keys.some((key) => !["title", "body", "classification", "evidenceReferences"].includes(key))) {
      throw new Error(`${label} is malformed.`);
    }
    const classification = requiredStoryText(step.classification, `${label} classification`, 32);
    if (classification !== "direct evidence" && classification !== "inference") {
      throw new Error(`${label} must be explicitly classified as direct evidence or inference.`);
    }
    if (!Array.isArray(step.evidenceReferences) || step.evidenceReferences.length < 1 || step.evidenceReferences.length > 3) {
      throw new Error(`${label} must cite between 1 and 3 evidence references.`);
    }
    const references = step.evidenceReferences.map((reference, referenceIndex) => requiredStoryText(reference, `${label} evidenceReferences[${referenceIndex + 1}]`, 100));
    if (new Set(references).size !== references.length) throw new Error(`${label} evidenceReferences must not contain duplicate references.`);
    for (const reference of references) {
      const evidence = evidenceByReference.get(reference);
      const availability = text(evidence?.availability);
      if (!evidence || availability === "excluded" || availability === "missing") {
        throw new Error(`${label} cites evidence outside the included redacted source bundle.`);
      }
    }
    const normalized = {
      title: requiredStoryText(step.title, `${label} title`, 160),
      body: requiredStoryText(step.body, `${label} body`, 2000),
      classification,
      references,
    };
    const identity = JSON.stringify({ ...normalized, references: [...references].sort() });
    if (identities.has(identity)) throw new Error(`${label} duplicates an earlier story step.`);
    identities.add(identity);
    return normalized;
  });
}

function dispositionReportId(recommendations, claims) {
  // This opaque, deterministic identifier stays local to the report. Its scope
  // includes every current material claim and recommendation, so a report with
  // no recommendations cannot collapse into a shared constant identity.
  let hash = 2166136261;
  for (const character of JSON.stringify({ claims, recommendations })) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `hindsight-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function dispositionMetadata(recommendations, claims = []) {
  return {
    // Version 2 keeps the immutable, already-validated model work fields with
    // the local user decision. This makes an exported decision self-contained
    // for the separate trusted-project work workflow; it never adds a network
    // capability to this report.
    schemaVersion: 2,
    kind: "pi-hindsight-recommendation-dispositions",
    reportId: dispositionReportId(recommendations, claims),
    provenance: {
      modelSuggestions: "model-suggestion",
      userDispositions: "not-user-confirmed",
    },
    recommendations: recommendations.map((recommendation, index) => ({
      recommendationNumber: index + 1,
      modelSuggestion: {
        status: recommendation.status,
        source: recommendation.source,
        recommendation: recommendation.recommendation,
        priority: recommendation.priority,
        expectedImpact: recommendation.expectedImpact,
        suggestedOwner: recommendation.suggestedOwner,
        dependencies: recommendation.dependencies,
        acceptanceCriteria: recommendation.acceptanceCriteria,
        evidenceReferences: recommendation.references,
      },
      userDisposition: { status: "not-recorded", source: "not-user-confirmed", rationale: "" },
    })),
  };
}

/**
 * Creates the local companion/export metadata contract for a report. It repeats
 * the safe recommendation validation so callers cannot persist arbitrary data.
 */
export function createHindsightRecommendationDispositionMetadata(document) {
  return dispositionMetadata(normalizedRecommendations(document), normalizedReportIdentityClaims(document));
}

function scriptJson(value) {
  // JSON in a script element must not permit a model string to close that tag.
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function normalizedClaimSupportValidation(document, claims) {
  const validation = document?.claimSupportValidation;
  const materialClaims = claims.filter((claim) => !claim.validationExcluded);
  if (validation === undefined) return undefined;
  if (!validation || typeof validation !== "object" || Array.isArray(validation)
    || text(validation.source) !== "model-validation" || text(validation.userDisposition) !== "not-user-confirmed") {
    throw new Error("Claim-support validation must be model-generated and not user-confirmed.");
  }
  const assessments = validation.assessments;
  if (!Array.isArray(assessments) || assessments.length !== materialClaims.length) {
    throw new Error("Claim-support validation must assess every material claim exactly once.");
  }
  const claimNumbers = new Set();
  return assessments.map((assessment, index) => {
    const label = `Claim-support assessment ${index + 1}`;
    const claimNumber = assessment?.claimNumber;
    if (!Number.isInteger(claimNumber) || claimNumber < 1 || claimNumber > materialClaims.length || claimNumbers.has(claimNumber)) {
      throw new Error("Claim-support validation must assess every material claim exactly once.");
    }
    claimNumbers.add(claimNumber);
    const support = text(assessment?.support);
    if (!["supported", "partially supported", "unsupported", "unverifiable"].includes(support)) {
      throw new Error(`${label} has an invalid support classification.`);
    }
    const rationale = bounded(assessment?.rationale, "", 1000);
    if (!rationale) throw new Error(`${label} requires a readable rationale.`);
    const references = [...new Set((Array.isArray(assessment?.evidenceReferences) ? assessment.evidenceReferences : []).map(text))];
    const claimReferences = materialClaims[claimNumber - 1].references;
    if (references.length !== claimReferences.length || references.some((reference) => !reference) || claimReferences.some((reference) => !references.includes(reference))) {
      throw new Error(`${label} must evaluate exactly the claim's cited redacted evidence excerpts.`);
    }
    return { claimNumber, support, rationale, references };
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
    return { statement, classification, references, validationExcluded: claim?.validationExcluded === true };
  });
  const storySteps = normalizedStorySteps(document, evidenceByReference);
  const recommendations = normalizedRecommendations(document);
  const recommendationDispositionMetadata = dispositionMetadata(recommendations, normalizedClaims);
  // Feedback identities are hashes of the stable rendered claim/recommendation
  // contract plus pseudonymous citations, never source excerpts or raw sessions.
  // Generic renderer callers may use synthetic citations outside the durable
  // feedback contract. Real synthesis accepts only pseudonymous citations; a
  // generic preview remains renderable but deliberately has no feedback seed.
  let feedbackMetadata;
  try {
    feedbackMetadata = createHindsightFeedbackMetadata({
      reportId: recommendationDispositionMetadata.reportId,
      claims: normalizedClaims.map((claim) => ({ ...claim, evidenceReferences: claim.references })),
      recommendations: recommendations.map((recommendation) => ({ ...recommendation, evidenceReferences: recommendation.references })),
    });
  } catch {
    feedbackMetadata = undefined;
  }
  const claimSupportValidation = normalizedClaimSupportValidation(document, normalizedClaims);
  // Prior outcomes enter only through an explicit, separately validated caller
  // path. They are rendered as user context and never join the evidence index.
  const priorOutcomeHtml = document?.priorOutcomes
    ? renderHindsightOutcomeHistoryHtml(document.priorOutcomes, { heading: "Prior user-observed outcome context", priorContext: true })
    : "";
  // Notes deliberately remain outside the evidence index: they have no anchors,
  // no references, and are rendered with their distinct user-authored provenance.
  const userAuthoredNotes = Array.isArray(document?.userAuthoredNotes) ? document.userAuthoredNotes : [];
  const userAuthoredNotesHtml = userAuthoredNotes.length === 0 ? "" : `<section class="user-authored-notes" aria-labelledby="user-authored-notes-heading"><h2 id="user-authored-notes-heading">User-authored hindsight context</h2><p class="empty">Reviewed user-authored context only; it is not conversation evidence, cannot satisfy citations, and was not treated as direct evidence.</p><ol>${userAuthoredNotes.map((note) => `<li><p class="provenance">user-authored · user-confirmed</p><p class="context">${escapeHtml(bounded(note?.text, "", 2000))}</p></li>`).join("")}</ol></section>`;

  // Missing references retain a navigable, explicit fallback rather than a dead link.
  const referenced = [...new Set([
    ...normalizedClaims.flatMap((claim) => claim.references),
    ...storySteps.flatMap((step) => step.references),
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

  const storyCitationChips = (references) => references.map((reference) => `<a class="evidence-chip" href="#${citationAnchors.get(reference)}">${escapeHtml(reference)}</a>`).join(" ");
  const storyHtml = storySteps.length === 0
    ? '<p class="empty" role="status">No model-suggested story steps were supplied. Read the cited claims and evidence in document order.</p>'
    : `<p class="story-provenance">Model-suggested evidence-first reading guide; story steps are not user-confirmed facts.</p><div class="story-filter"><button type="button" id="story-direct-evidence-filter" aria-pressed="false" aria-controls="story-reading-order">Show direct evidence only</button><p id="story-filter-status" class="empty" role="status">All evidence classifications are shown.</p></div><ol id="story-reading-order" class="story-reading-order">${storySteps.map((step) => `<li class="story-step story-${step.classification.replace(/\s+/g, "-")}" data-story-classification="${step.classification}"><article><h3>${escapeHtml(step.title)}</h3><p class="classification">${step.classification === "inference" ? "Inference · model-suggested interpretation" : "Direct evidence · model-suggested reading step"}</p><p>${escapeHtml(step.body)}</p><p class="citations"><span class="empty">Cited evidence:</span> ${storyCitationChips(step.references)}</p></article></li>`).join("\n")}</ol>`;
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
    : `<div class="table-scroll" tabindex="0" aria-label="Scrollable recommendation table"><table><caption>Structured recommendations proposed by the model; none are user-confirmed.</caption><thead><tr><th scope="col">Recommendation</th><th scope="col">Priority</th><th scope="col">Expected impact</th><th scope="col">Suggested owner</th><th scope="col">Dependencies</th><th scope="col">Measurable acceptance criteria</th><th scope="col">Model provenance</th><th scope="col">Evidence</th></tr></thead><tbody>${recommendations.map((recommendation) => `<tr><th scope="row">${escapeHtml(recommendation.recommendation)}</th><td>${escapeHtml(recommendation.priority)}</td><td>${escapeHtml(recommendation.expectedImpact)}</td><td>${escapeHtml(recommendation.suggestedOwner)}</td><td>${list(recommendation.dependencies, "No dependencies specified")}</td><td>${list(recommendation.acceptanceCriteria, "No acceptance criteria supplied")}</td><td><span class="provenance">${escapeHtml(recommendation.status)} · ${escapeHtml(recommendation.source)}</span><br><span class="empty">Model suggestion; not user-confirmed</span></td><td class="citations">${citationLinks(recommendation.references)}</td></tr>`).join("\n")}</tbody></table></div>
    <section class="disposition-panel" aria-labelledby="disposition-heading"><h3 id="disposition-heading">User-confirmed recommendation dispositions</h3><p>These local controls do not alter the model suggestion or source conversation. Select a disposition and provide a rationale for every recommendation before exporting the local metadata.</p>${recommendations.map((_recommendation, index) => { const number = index + 1; return `<form class="disposition-form" data-disposition-form data-recommendation-number="${number}"><fieldset><legend>Recommendation ${number}: user-confirmed disposition</legend><p class="model-provenance">Model suggestion remains <strong>proposed · model-suggestion</strong>.</p><div class="disposition-options" role="radiogroup" aria-describedby="disposition-help-${number}"><label><input type="radio" name="disposition-${number}" value="accepted" required> Accept</label><label><input type="radio" name="disposition-${number}" value="deferred"> Defer</label><label><input type="radio" name="disposition-${number}" value="rejected"> Reject</label></div><p id="disposition-help-${number}" class="empty">A rationale is required to preserve the user-confirmed decision separately from the model suggestion.</p><label for="disposition-rationale-${number}">Rationale</label><textarea id="disposition-rationale-${number}" name="rationale" required maxlength="1000" aria-describedby="disposition-help-${number}"></textarea><div class="disposition-actions"><button type="submit">Save disposition locally</button><span class="disposition-status" role="status" aria-live="polite"></span></div></fieldset></form>`; }).join("")}</section>
    <section class="disposition-export" aria-labelledby="disposition-export-heading"><h3 id="disposition-export-heading">Export local disposition metadata</h3><p>Export includes the original recommendation text, pseudonymous evidence citations, model provenance, and the user-confirmed disposition. It is downloaded locally; this report makes no network request.</p><button type="button" id="export-dispositions">Export disposition metadata JSON</button><p id="export-disposition-status" role="status" aria-live="polite"></p></section>`;
  // This delimited safe placeholder is replaced only by the local outcome
  // workflow. It keeps history inspectable in this report without giving the
  // browser or the model filesystem/network access.
  const outcomeHistoryPlaceholder = '<!-- pi-hindsight-outcomes:start --><section class="hindsight-outcomes" aria-labelledby="hindsight-outcomes-heading"><h2 id="hindsight-outcomes-heading">User-observed outcome history</h2><p class="empty" role="status">No local outcome history has been recorded for this report.</p></section><!-- pi-hindsight-outcomes:end -->';
  const feedbackPlaceholder = `<!-- pi-hindsight-feedback:start -->${feedbackMetadata ? renderHindsightFeedbackHtml(feedbackMetadata) : '<section class="hindsight-feedback" aria-labelledby="hindsight-feedback-heading"><h2 id="hindsight-feedback-heading">Local feedback and calibration signals</h2><p class="empty" role="status">Local feedback is unavailable because this preview has no durable pseudonymous feedback identity.</p></section>'}<!-- pi-hindsight-feedback:end -->`;
  const claimSupportHtml = !claimSupportValidation
    ? '<p class="empty" role="status">Claim-support validation was not requested.</p>'
    : claimSupportValidation.length === 0
      ? '<p class="empty" role="status">No material generated claims were available for claim-support validation.</p>'
      : `<p class="empty">Model-generated validation only; it is not a user-confirmed disposition.</p><ol class="claim-support-list">${claimSupportValidation.map((assessment) => `<li><strong>Claim ${assessment.claimNumber}:</strong> <span class="provenance">${escapeHtml(assessment.support)}</span><br><span class="empty">Rationale:</span> ${escapeHtml(assessment.rationale)}<br><span class="empty">Evidence evaluated:</span> <span class="citations">${citationLinks(assessment.references)}</span></li>`).join("")}</ol>`;
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
  const storyFilterScript = storySteps.length === 0 ? "" : `<script>(() => {
    const button = document.getElementById("story-direct-evidence-filter");
    const status = document.getElementById("story-filter-status");
    const steps = Array.from(document.querySelectorAll("[data-story-classification]"));
    if (!button || !status) return;
    let directOnly = false;
    button.addEventListener("click", () => {
      directOnly = !directOnly;
      for (const step of steps) step.hidden = directOnly && step.dataset.storyClassification !== "direct evidence";
      button.setAttribute("aria-pressed", String(directOnly));
      button.textContent = directOnly ? "Show all story steps" : "Show direct evidence only";
      status.textContent = directOnly ? "Showing direct-evidence story steps only." : "All evidence classifications are shown.";
    });
  })();</script>`;
  const dispositionScript = `<script type="application/json" id="disposition-seed">${scriptJson(recommendationDispositionMetadata)}</script><script>(() => {
    const seedElement = document.getElementById("disposition-seed");
    const exportButton = document.getElementById("export-dispositions");
    const exportStatus = document.getElementById("export-disposition-status");
    if (!seedElement || !exportButton || !exportStatus) return;
    let seed;
    try { seed = JSON.parse(seedElement.textContent); } catch { return; }
    const forms = Array.from(document.querySelectorAll("[data-disposition-form]"));
    const storageKey = "pi-hindsight-dispositions-v1:" + seed.reportId;
    const statusFor = (form) => form.querySelector(".disposition-status");
    const capture = (form, requireComplete) => {
      const status = form.querySelector("input[type=radio]:checked");
      const rationale = form.querySelector("textarea").value.trim();
      if (!status || !rationale) {
        if (requireComplete) form.reportValidity();
        return undefined;
      }
      return { recommendationNumber: Number(form.dataset.recommendationNumber), status: status.value, source: "user-confirmed", rationale, confirmedAt: new Date().toISOString() };
    };
    const localState = () => ({ schemaVersion: 1, reportId: seed.reportId, dispositions: forms.map((form) => capture(form, false)).filter(Boolean) });
    const persist = () => { try { localStorage.setItem(storageKey, JSON.stringify(localState())); return true; } catch { return false; } };
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      for (const item of saved?.dispositions || []) {
        const form = forms.find((candidate) => Number(candidate.dataset.recommendationNumber) === item.recommendationNumber);
        const radio = Array.from(form?.querySelectorAll("input[type=radio]") || []).find((candidate) => candidate.value === item.status);
        if (radio && typeof item.rationale === "string") { radio.checked = true; form.querySelector("textarea").value = item.rationale; statusFor(form).textContent = "Previously saved locally."; }
      }
    } catch { /* Local persistence is optional when browser storage is unavailable. */ }
    for (const form of forms) form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!capture(form, true)) return;
      statusFor(form).textContent = persist() ? "Disposition saved locally." : "Browser local storage is unavailable; export the metadata instead.";
    });
    exportButton.addEventListener("click", () => {
      const dispositions = [];
      for (const form of forms) { const item = capture(form, true); if (!item) return; dispositions.push(item); }
      const byNumber = new Map(dispositions.map((item) => [item.recommendationNumber, item]));
      const metadata = { ...seed, provenance: { ...seed.provenance, userDispositions: "user-confirmed" }, exportedAt: new Date().toISOString(), recommendations: seed.recommendations.map((recommendation) => ({ ...recommendation, userDisposition: byNumber.get(recommendation.recommendationNumber) })) };
      persist();
      const download = document.createElement("a");
      download.href = URL.createObjectURL(new Blob([JSON.stringify(metadata, null, 2) + "\\n"], { type: "application/json" }));
      download.download = "pi-hindsight-dispositions-" + seed.reportId + ".json";
      download.hidden = true;
      document.body.append(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(download.href), 0);
      exportStatus.textContent = "Disposition metadata exported locally.";
    });
  })();</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Pi hindsight document</title><style>:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#1a1b26;color:#c0caf5}body{margin:0 auto;max-width:80rem;padding:2rem;line-height:1.45}.claim,.evidence,.story-step article,.claim-support-list li,.disposition-panel,.disposition-export{background:#24283b;border:1px solid #414868;border-radius:.5rem;margin:1rem 0;padding:1rem}.claim-inference{border-left:.5rem solid #a66b12}.claim-direct-evidence{border-left:.5rem solid #2c78c4}.classification,.provenance,.story-provenance{font-size:.85rem;font-weight:700;text-transform:capitalize}.story-provenance{color:#a9b1d6}.story-reading-order{padding-left:1.5rem}.story-step{margin:1rem 0;padding-left:.25rem}.story-inference article{border-left:.5rem solid #a66b12}.story-direct-evidence article{border-left:.5rem solid #2c78c4}.story-filter{align-items:center;display:flex;flex-wrap:wrap;gap:.75rem}.story-filter p{margin:.25rem 0}.citations a{font-weight:700}.evidence-chip{background:#2f354d;border:1px solid #414868;border-radius:1rem;display:inline-block;margin:.15rem .2rem .15rem 0;padding:.12rem .5rem;text-decoration:none}.context{white-space:pre-wrap;overflow-wrap:anywhere}.context-panel{border-top:1px dashed #414868;margin-top:.9rem;padding-top:.2rem;scroll-margin-top:1rem}.context-panel h4,.evidence h4{margin-bottom:.25rem}.evidence-unavailable{border-left:.5rem solid #a66b12}.context-fallback,.empty{color:#a9b1d6}.claim-support-list{list-style-position:inside;padding:0}.table-scroll{overflow-x:auto;margin:1rem 0}.table-scroll:focus,.disposition-form :focus-visible,button:focus-visible{outline:2px solid #7aa2f7;outline-offset:2px}table{border-collapse:collapse;min-width:72rem;width:100%;background:#24283b}caption{text-align:left;font-weight:700;padding:.5rem 0}th,td{border:1px solid #414868;padding:.7rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}thead th{background:#2f354d}tbody th{min-width:14rem}td ul{margin:.1rem 0;padding-left:1.2rem}.disposition-form{border-top:1px solid #414868;margin-top:1rem;padding-top:1rem}.disposition-form:first-of-type{border-top:0;margin-top:0}.disposition-form fieldset{border:0;margin:0;padding:0}.disposition-options{display:flex;flex-wrap:wrap;gap:1rem}.disposition-options label{font-weight:700}.disposition-form textarea{box-sizing:border-box;display:block;min-height:5rem;max-width:48rem;width:100%}.disposition-actions{align-items:center;display:flex;flex-wrap:wrap;gap:.75rem;margin-top:.75rem}.disposition-status{font-weight:700}.model-provenance{color:#a9b1d6}</style></head><body><h1>${escapeHtml(bounded(document?.title, "Pi hindsight document", 160))}</h1><p>Claims label direct evidence separately from model-generated inference. Every material claim and recommendation links to embedded redacted source context, with flow and relationship-map context where available.</p><main><section aria-labelledby="story-heading"><h2 id="story-heading">Evidence-first story reading order</h2>${storyHtml}</section><section aria-labelledby="claims-heading"><h2 id="claims-heading">Claims</h2>${claimHtml}</section><section aria-labelledby="claim-support-heading"><h2 id="claim-support-heading">Claim-support validation</h2>${claimSupportHtml}</section><section aria-labelledby="recommendations-heading"><h2 id="recommendations-heading">Recommendations</h2>${recommendationHtml}</section>${outcomeHistoryPlaceholder}${feedbackPlaceholder}${priorOutcomeHtml}${userAuthoredNotesHtml}</main><section><h2>Evidence</h2>${evidenceHtml}</section>${storyFilterScript}${recommendations.length === 0 ? "" : dispositionScript}</body></html>`;
}
