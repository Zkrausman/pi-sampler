import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { escapeHtml } from "./catalog.mjs";

const REPORT_ID = /^hindsight-[a-f0-9]{8}$/;
const CITATION = /^session-[a-z0-9]+:event-[0-9]{4}$/;
const ISSUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OUTCOME_STATUSES = new Set(["not-started", "in-progress", "completed", "paused", "stopped"]);
const FOLLOW_UP_DECISIONS = new Set(["continue", "adjust", "monitor", "stop", "no-follow-up"]);
const outcomeLocks = new Map();

export class HindsightOutcomeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function ownObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  return ownObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function boundedText(value, maxLength, code = "malformed_outcome") {
  if (typeof value !== "string") throw new HindsightOutcomeError(code);
  const text = value.trim();
  if (!text || Array.from(text).length > maxLength) throw new HindsightOutcomeError(code);
  return text;
}

// Outcome fields are user input, not a channel for session transcripts or credentials.
// Reject recognizable raw-session identifiers and common secret forms rather than
// copying them into durable JSON or the inspectable HTML companion.
const UNSAFE_OUTCOME_TEXT = /\b(?:raw[- ]?session(?:[- ]?id)?|session[_-]?id|pi_session_file|bearer\s+|api[_-]?key|authorization\s*:|gh[pousr]_[A-Za-z0-9_]{20,})\b/i;

function safeOutcomeText(value) {
  const result = boundedText(value, 2000, "malformed_outcome");
  if (UNSAFE_OUTCOME_TEXT.test(result)) throw new HindsightOutcomeError("unsafe_outcome_text");
  return result;
}

function boundedReferences(value, code = "malformed_outcome") {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new HindsightOutcomeError(code);
  const references = value.map((reference) => boundedText(reference, 100, code));
  if (new Set(references).size !== references.length || references.some((reference) => !CITATION.test(reference))) {
    throw new HindsightOutcomeError(code);
  }
  return references;
}

function validTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function validHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.href === value;
  } catch {
    return false;
  }
}

function digestModelSuggestion(recommendation) {
  const model = {
    recommendation: recommendation.recommendation,
    priority: recommendation.priority,
    expectedImpact: recommendation.expectedImpact,
    suggestedOwner: recommendation.suggestedOwner,
    dependencies: recommendation.dependencies,
    acceptanceCriteria: recommendation.acceptanceCriteria,
    evidenceReferences: recommendation.evidenceReferences,
  };
  return createHash("sha256").update(JSON.stringify(model)).digest("hex");
}

/** Builds an immutable, pseudonymous origin from strictly parsed accepted metadata. */
export function createHindsightOutcomeOrigin(reportId, recommendation) {
  if (!REPORT_ID.test(reportId) || !recommendation || !Number.isInteger(recommendation.recommendationNumber)
    || recommendation.recommendationNumber < 1 || recommendation.userDisposition?.status !== "accepted"
    || recommendation.userDisposition?.source !== "user-confirmed") {
    throw new HindsightOutcomeError("accepted_recommendation_required");
  }
  return {
    reportId,
    recommendationNumber: recommendation.recommendationNumber,
    modelSuggestionDigest: digestModelSuggestion(recommendation),
    evidenceReferences: boundedReferences(recommendation.evidenceReferences, "accepted_recommendation_required"),
  };
}

function normalizeOrigin(origin, code = "malformed_outcome") {
  if (!exactKeys(origin, ["reportId", "recommendationNumber", "modelSuggestionDigest", "evidenceReferences"])
    || typeof origin.reportId !== "string" || !REPORT_ID.test(origin.reportId)
    || !Number.isInteger(origin.recommendationNumber) || origin.recommendationNumber < 1
    || typeof origin.modelSuggestionDigest !== "string" || !/^[a-f0-9]{64}$/.test(origin.modelSuggestionDigest)) {
    throw new HindsightOutcomeError(code);
  }
  return {
    reportId: origin.reportId,
    recommendationNumber: origin.recommendationNumber,
    modelSuggestionDigest: origin.modelSuggestionDigest,
    evidenceReferences: boundedReferences(origin.evidenceReferences, code),
  };
}

function sameOrigin(first, second) {
  return first.reportId === second.reportId && first.recommendationNumber === second.recommendationNumber
    && first.modelSuggestionDigest === second.modelSuggestionDigest
    && first.evidenceReferences.length === second.evidenceReferences.length
    && first.evidenceReferences.every((reference, index) => reference === second.evidenceReferences[index]);
}

function normalizeWorkLink(value) {
  if (!exactKeys(value, ["issueId", "issueUrl", "status", "timestamp", "payloadDigest", "action"])
    || typeof value.issueId !== "string" || !ISSUE_ID.test(value.issueId)
    || typeof value.issueUrl !== "string" || !validHttpsUrl(value.issueUrl)
    || typeof value.status !== "string" || !value.status.trim() || Array.from(value.status).length > 160
    || !validTimestamp(value.timestamp) || typeof value.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.payloadDigest)
    || !["created", "linked"].includes(value.action)) {
    throw new HindsightOutcomeError("malformed_outcome");
  }
  return { issueId: value.issueId, issueUrl: value.issueUrl, status: value.status.trim(), timestamp: value.timestamp, payloadDigest: value.payloadDigest, action: value.action };
}

function normalizeUpdate(value, expectedNumber) {
  if (!exactKeys(value, ["updateNumber", "status", "observedResult", "measurementEvidence", "unexpectedEffects", "followUpDecision", "provenance", "workLink"])
    || !Number.isInteger(value.updateNumber) || value.updateNumber !== expectedNumber
    || typeof value.status !== "string" || !OUTCOME_STATUSES.has(value.status)
    || typeof value.followUpDecision !== "string" || !FOLLOW_UP_DECISIONS.has(value.followUpDecision)
    || !exactKeys(value.provenance, ["source", "confirmation", "confirmedAt"])
    || value.provenance.source !== "user-observed" || value.provenance.confirmation !== "user-confirmed"
    || !validTimestamp(value.provenance.confirmedAt)) {
    throw new HindsightOutcomeError("malformed_outcome");
  }
  const update = {
    updateNumber: value.updateNumber,
    status: value.status,
    observedResult: safeOutcomeText(value.observedResult),
    measurementEvidence: safeOutcomeText(value.measurementEvidence),
    unexpectedEffects: safeOutcomeText(value.unexpectedEffects),
    followUpDecision: value.followUpDecision,
    provenance: { source: "user-observed", confirmation: "user-confirmed", confirmedAt: value.provenance.confirmedAt },
  };
  if (value.workLink !== undefined) update.workLink = normalizeWorkLink(value.workLink);
  return update;
}

export function outcomeHistoryPathForDispositionPath(dispositionPath) {
  if (typeof dispositionPath !== "string" || dispositionPath.includes("\0") || !dispositionPath.endsWith(".dispositions.json")) {
    throw new HindsightOutcomeError("invalid_disposition_path");
  }
  return dispositionPath.replace(/\.dispositions\.json$/, ".outcomes.json");
}

export function outcomeHistoryReportPathForDispositionPath(dispositionPath) {
  if (typeof dispositionPath !== "string" || dispositionPath.includes("\0") || !dispositionPath.endsWith(".dispositions.json")) {
    throw new HindsightOutcomeError("invalid_disposition_path");
  }
  return dispositionPath.replace(/\.dispositions\.json$/, ".outcomes.html");
}

export function hindsightReportPathForDispositionPath(dispositionPath) {
  if (typeof dispositionPath !== "string" || dispositionPath.includes("\0") || !dispositionPath.endsWith(".dispositions.json")) {
    throw new HindsightOutcomeError("invalid_disposition_path");
  }
  return dispositionPath.replace(/\.dispositions\.json$/, ".html");
}

export function emptyHindsightOutcomeHistory(origin) {
  const normalized = normalizeOrigin(origin, "accepted_recommendation_required");
  return { schemaVersion: 1, kind: "pi-hindsight-recommendation-outcomes", origin: normalized, updates: [] };
}

/** Strictly parses persisted outcome history without accepting source text or arbitrary identities. */
export function parseHindsightOutcomeHistory(value) {
  if (!exactKeys(value, ["schemaVersion", "kind", "origin", "updates"])
    || value.schemaVersion !== 1 || value.kind !== "pi-hindsight-recommendation-outcomes" || !Array.isArray(value.updates)
    || value.updates.length > 200) {
    throw new HindsightOutcomeError("malformed_outcome");
  }
  const origin = normalizeOrigin(value.origin);
  return { schemaVersion: 1, kind: "pi-hindsight-recommendation-outcomes", origin, updates: value.updates.map((update, index) => normalizeUpdate(update, index + 1)) };
}

export async function readHindsightOutcomeHistory(path) {
  try {
    return parseHindsightOutcomeHistory(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof HindsightOutcomeError) throw error;
    throw new HindsightOutcomeError("malformed_outcome");
  }
}

/** Serializes append-only updates for one outcome file within a Pi process. */
export async function withHindsightOutcomeLock(path, operation) {
  if (typeof path !== "string" || !path) throw new HindsightOutcomeError("invalid_disposition_path");
  const previous = outcomeLocks.get(path) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  outcomeLocks.set(path, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (outcomeLocks.get(path) === current) outcomeLocks.delete(path);
  }
}

/** Atomically appends one user-observed/user-confirmed update for its exact immutable origin. */
export async function appendHindsightOutcomeUpdate(path, origin, update) {
  const expectedOrigin = normalizeOrigin(origin, "accepted_recommendation_required");
  const existing = await readHindsightOutcomeHistory(path);
  const history = existing || emptyHindsightOutcomeHistory(expectedOrigin);
  if (!sameOrigin(history.origin, expectedOrigin)) throw new HindsightOutcomeError("outcome_origin_mismatch");
  const normalized = normalizeUpdate({ ...update, updateNumber: history.updates.length + 1 }, history.updates.length + 1);
  const replacement = { ...history, updates: [...history.updates, normalized] };
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(replacement, null, 2)}\n`, "utf8");
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return replacement;
}

function outcomeRows(history) {
  if (history.updates.length === 0) return '<p class="empty" role="status">No user-observed outcome updates are recorded.</p>';
  const workLink = (update) => update.workLink
    ? `<p><strong>Existing work link at confirmation:</strong> <a href="${escapeHtml(update.workLink.issueUrl)}" rel="noreferrer">${escapeHtml(update.workLink.issueId)}</a> · ${escapeHtml(update.workLink.status)} · ${escapeHtml(update.workLink.action)}</p>`
    : '<p class="empty">No existing work link was present when this update was confirmed.</p>';
  return `<ol class="outcome-history">${history.updates.map((update) => `<li><h3>Update ${update.updateNumber}</h3><p><strong>Status:</strong> ${escapeHtml(update.status)} · <strong>Follow-up decision:</strong> ${escapeHtml(update.followUpDecision)}</p><dl><dt>Observed result</dt><dd>${escapeHtml(update.observedResult)}</dd><dt>Measurement or user-supplied evidence</dt><dd>${escapeHtml(update.measurementEvidence)}</dd><dt>Unexpected effects</dt><dd>${escapeHtml(update.unexpectedEffects)}</dd></dl>${workLink(update)}<p class="provenance">${escapeHtml(update.provenance.source)} · ${escapeHtml(update.provenance.confirmation)} · ${escapeHtml(update.provenance.confirmedAt)}</p></li>`).join("")}</ol>`;
}

/** Safe rendering labels outcome text as user context, never source evidence for claims. */
export function renderHindsightOutcomeHistoryHtml(history, { heading = "User-observed outcome history", priorContext = false } = {}) {
  const parsed = parseHindsightOutcomeHistory(history);
  const origin = parsed.origin;
  const context = priorContext
    ? "Deliberately supplied prior-outcome context. It is user-observed/user-confirmed context, not source evidence and must not support unrelated claims."
    : "User-observed/user-confirmed local outcome history. It is not model inference or source evidence for unrelated claims.";
  return `<section class="hindsight-outcomes" aria-labelledby="hindsight-outcomes-heading"><h2 id="hindsight-outcomes-heading">${escapeHtml(heading)}</h2><p class="outcome-notice">${context}</p><p class="outcome-origin">Origin: report ${escapeHtml(origin.reportId)}, recommendation ${origin.recommendationNumber}. Originating pseudonymous citations (not outcome evidence): ${origin.evidenceReferences.map(escapeHtml).join(", ")}.</p>${outcomeRows(parsed)}</section>`;
}

export function renderHindsightOutcomeHistoryDocumentHtml(history) {
  const body = renderHindsightOutcomeHistoryHtml(history, { heading: "Hindsight recommendation outcome history" });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Pi hindsight outcome history</title><style>:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#1a1b26;color:#c0caf5}body{margin:0 auto;max-width:64rem;padding:2rem;line-height:1.45}.hindsight-outcomes,.outcome-history li{background:#24283b;border:1px solid #414868;border-radius:.5rem;margin:1rem 0;padding:1rem}.outcome-history{padding-left:1.5rem}.outcome-history li{margin:.75rem 0}.outcome-history h3{margin-top:0}.outcome-history dt{font-weight:700;margin-top:.75rem}.outcome-history dd{margin-left:0;white-space:pre-wrap;overflow-wrap:anywhere}.empty,.outcome-notice{color:#a9b1d6}.provenance{font-size:.9rem;font-weight:700}.outcome-origin{overflow-wrap:anywhere}a:focus-visible{outline:2px solid #7aa2f7;outline-offset:2px}</style></head><body><main>${body}</main></body></html>`;
}

/** Rewrites the inspectable local outcome-history companion through an atomic replacement. */
async function atomicWrite(path, content) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, content, "utf8");
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeHindsightOutcomeHistoryReport(path, history) {
  await atomicWrite(path, renderHindsightOutcomeHistoryDocumentHtml(history));
}

/** Refreshes only the delimited safe outcome section in a report this extension generated. */
export async function refreshHindsightReportOutcomeHistory(path, history) {
  const source = await readFile(path, "utf8");
  const marker = /<!-- pi-hindsight-outcomes:start -->[\s\S]*?<!-- pi-hindsight-outcomes:end -->/g;
  const matches = source.match(marker);
  if (!matches || matches.length !== 1) throw new HindsightOutcomeError("outcome_report_marker_missing");
  const replacement = `<!-- pi-hindsight-outcomes:start -->${renderHindsightOutcomeHistoryHtml(history)}<!-- pi-hindsight-outcomes:end -->`;
  await atomicWrite(path, source.replace(marker, replacement));
}
