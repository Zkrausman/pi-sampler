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

/**
 * Renders a saved/exportable hindsight document from explicit claims and a
 * redacted evidence snapshot. Callers must cite every material claim; direct
 * evidence and model inference are deliberately styled and labeled differently.
 */
export function generateCitedHindsightDocumentHtml(document) {
  const claims = Array.isArray(document?.claims) ? document.claims : [];
  const evidence = Array.isArray(document?.evidence) ? document.evidence : [];
  const evidenceByReference = new Map();
  const citationAnchors = new Map();
  for (const [index, item] of evidence.entries()) {
    const reference = text(item?.reference);
    if (!reference || evidenceByReference.has(reference)) throw new Error("Evidence references must be unique and non-empty.");
    evidenceByReference.set(reference, item);
    // IDs are generated from ordinal positions, never from a lossy source-reference transform.
    citationAnchors.set(reference, `citation-${index + 1}`);
  }
  const normalizedClaims = claims.map((claim, index) => {
    const statement = bounded(claim?.statement, "No readable claim");
    const classification = text(claim?.classification);
    if (classification !== "direct evidence" && classification !== "inference") {
      throw new Error(`Claim ${index + 1} must be explicitly classified as direct evidence or inference.`);
    }
    const requestedReferences = (Array.isArray(claim?.evidenceReferences) ? claim.evidenceReferences : []).map(text);
    if (requestedReferences.length === 0) throw new Error(`Claim ${index + 1} has no inspectable source evidence.`);
    const unavailable = requestedReferences.find((reference) => !reference || !evidenceByReference.has(reference));
    if (unavailable !== undefined) throw new Error(`Claim ${index + 1} cites unavailable source evidence.`);
    return { statement, classification, references: [...new Set(requestedReferences)] };
  });
  const claimHtml = normalizedClaims.length === 0
    ? '<p class="empty">No material claims were supplied.</p>'
    : normalizedClaims.map((claim) => `<article class="claim claim-${claim.classification.replace(/\s+/g, "-")}">
      <p class="classification">${escapeHtml(claim.classification)}</p><p>${escapeHtml(claim.statement)}</p>
      <p class="citations">Evidence: ${claim.references.map((reference) => `<a href="#${citationAnchors.get(reference)}">${escapeHtml(reference)}</a>`).join(", ")}</p>
    </article>`).join("\n");
  const evidenceHtml = evidence.length === 0
    ? '<p class="empty">No evidence snapshot was supplied.</p>'
    : evidence.map((item) => {
      const reference = text(item?.reference);
      return `<article id="${citationAnchors.get(reference)}" class="evidence"><h3>${escapeHtml(reference)}</h3>
        <p class="classification">direct evidence</p><p class="context">${escapeHtml(bounded(item?.context))}</p>
      </article>`;
    }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pi hindsight document</title><style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0 auto;max-width:65rem;padding:2rem;line-height:1.45}.claim,.evidence{border:1px solid #9997;border-radius:.5rem;margin:1rem 0;padding:1rem}.claim-inference{border-left:.5rem solid #a66b12}.claim-direct-evidence{border-left:.5rem solid #2c78c4}.classification{font-size:.85rem;font-weight:700;text-transform:capitalize}.citations a{font-weight:700}.context{white-space:pre-wrap;overflow-wrap:anywhere}.empty{color:#666}</style></head><body><h1>${escapeHtml(bounded(document?.title, "Pi hindsight document", 160))}</h1><p>Claims label direct evidence separately from model-generated inference. Every material claim links to inspectable source context below.</p><main>${claimHtml}</main><section><h2>Evidence</h2>${evidenceHtml}</section></body></html>`;
}
