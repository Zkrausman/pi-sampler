import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { escapeHtml } from "./catalog.mjs";

const REPORT_ID = /^hindsight-[a-f0-9]{8}$/;
const CITATION = /^session-[a-z0-9]+:event-[0-9]{4}$/;
const ISSUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OUTCOME_STATUSES = new Set(["not-started", "in-progress", "completed", "paused", "stopped"]);
const FOLLOW_UP_DECISIONS = new Set(["continue", "adjust", "monitor", "stop", "no-follow-up"]);
const OUTCOME_LOCK_TIMEOUT_MS = 10_000;
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
const UNSAFE_OUTCOME_TEXT = /\b(?:raw[- ]?session(?:[- ]?id)?|session[_-]?id|pi_session_file|bearer\s+|api[_-]?key|authorization\s*:|gh[pousr]_[A-Za-z0-9_]{20,}|(?:akia|asia|aida|aroa)[a-z0-9]{16}|(?:aws_)?(?:secret_access_key|access_key_id)\s*[:=])\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

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

export function hindsightOutcomeOriginKey(origin) {
  const normalized = normalizeOrigin(origin);
  return `${normalized.reportId}:recommendation-${normalized.recommendationNumber}:${normalized.modelSuggestionDigest}`;
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

function normalizeHistory(value) {
  if (!exactKeys(value, ["origin", "updates"]) || !Array.isArray(value.updates) || value.updates.length > 200) {
    throw new HindsightOutcomeError("malformed_outcome");
  }
  return { origin: normalizeOrigin(value.origin), updates: value.updates.map((update, index) => normalizeUpdate(update, index + 1)) };
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

/** Creates the schema-version-2 indexed store for one accepted recommendation. */
export function emptyHindsightOutcomeHistory(origin) {
  const normalized = normalizeOrigin(origin, "accepted_recommendation_required");
  return {
    schemaVersion: 2,
    kind: "pi-hindsight-recommendation-outcomes",
    reportId: normalized.reportId,
    histories: { [hindsightOutcomeOriginKey(normalized)]: { origin: normalized, updates: [] } },
  };
}

/** Strictly parses a report-scoped, indexed outcome store. */
export function parseHindsightOutcomeHistory(value) {
  if (!exactKeys(value, ["schemaVersion", "kind", "reportId", "histories"])
    || value.schemaVersion !== 2 || value.kind !== "pi-hindsight-recommendation-outcomes"
    || typeof value.reportId !== "string" || !REPORT_ID.test(value.reportId) || !ownObject(value.histories)
    || Object.keys(value.histories).length < 1 || Object.keys(value.histories).length > 40) {
    throw new HindsightOutcomeError("malformed_outcome");
  }
  const histories = {};
  const recommendationNumbers = new Set();
  for (const [key, valueHistory] of Object.entries(value.histories)) {
    const history = normalizeHistory(valueHistory);
    if (history.origin.reportId !== value.reportId || key !== hindsightOutcomeOriginKey(history.origin)
      || recommendationNumbers.has(history.origin.recommendationNumber)) {
      throw new HindsightOutcomeError("malformed_outcome");
    }
    recommendationNumbers.add(history.origin.recommendationNumber);
    histories[key] = history;
  }
  return { schemaVersion: 2, kind: "pi-hindsight-recommendation-outcomes", reportId: value.reportId, histories };
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

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isTransientOutcomeLockContention(error, lockPath) {
  if (error?.code === "EEXIST") return true;
  // Windows can report EPERM while another process creates/removes this exact
  // lock directory. Limit that exception to the mkdir lock operation itself:
  // parent-directory access, malformed paths, and unrelated EPERM failures
  // still fail closed immediately.
  return error?.code === "EPERM" && error?.syscall === "mkdir" && error?.path === lockPath;
}

/** Exported for deterministic filesystem-error regression coverage. */
export async function acquireCrossProcessOutcomeLock(path, {
  mkdirImpl = mkdir,
  delayImpl = delay,
  now = () => Date.now(),
  timeoutMs = OUTCOME_LOCK_TIMEOUT_MS,
} = {}) {
  const lockPath = `${path}.lock`;
  await mkdirImpl(dirname(lockPath), { recursive: true });
  const deadline = now() + timeoutMs;
  let wait = 5;
  while (true) {
    try {
      await mkdirImpl(lockPath);
      return lockPath;
    } catch (error) {
      if (!isTransientOutcomeLockContention(error, lockPath)) throw error;
      if (now() >= deadline) throw new HindsightOutcomeError("outcome_lock_timeout");
      await delayImpl(wait);
      wait = Math.min(wait * 2, 100);
    }
  }
}

/** Serializes a complete read/mutate/write/render transaction across Pi processes. */
export async function withHindsightOutcomeLock(path, operation) {
  if (typeof path !== "string" || !path || path.includes("\0")) throw new HindsightOutcomeError("invalid_disposition_path");
  const previous = outcomeLocks.get(path) || Promise.resolve();
  let releaseLocal;
  const current = new Promise((resolve) => { releaseLocal = resolve; });
  outcomeLocks.set(path, current);
  await previous;
  let lockPath;
  try {
    lockPath = await acquireCrossProcessOutcomeLock(path);
    return await operation();
  } finally {
    if (lockPath) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    releaseLocal();
    if (outcomeLocks.get(path) === current) outcomeLocks.delete(path);
  }
}

async function appendHindsightOutcomeUpdateUnlocked(path, origin, update) {
  const expectedOrigin = normalizeOrigin(origin, "accepted_recommendation_required");
  const existing = await readHindsightOutcomeHistory(path);
  const store = existing || emptyHindsightOutcomeHistory(expectedOrigin);
  if (store.reportId !== expectedOrigin.reportId) throw new HindsightOutcomeError("outcome_origin_mismatch");
  const key = hindsightOutcomeOriginKey(expectedOrigin);
  const history = store.histories[key] || { origin: expectedOrigin, updates: [] };
  const normalized = normalizeUpdate({ ...update, updateNumber: history.updates.length + 1 }, history.updates.length + 1);
  const replacement = { ...store, histories: { ...store.histories, [key]: { origin: expectedOrigin, updates: [...history.updates, normalized] } } };
  await atomicWrite(path, `${JSON.stringify(replacement, null, 2)}\n`);
  return replacement;
}

/** Atomically appends one user-observed/user-confirmed update under its immutable origin key. */
export async function appendHindsightOutcomeUpdate(path, origin, update) {
  return withHindsightOutcomeLock(path, () => appendHindsightOutcomeUpdateUnlocked(path, origin, update));
}

function outcomeRows(history) {
  if (history.updates.length === 0) return '<p class="empty" role="status">No user-observed outcome updates are recorded.</p>';
  const workLink = (update) => update.workLink
    ? `<p><strong>Existing work link at confirmation:</strong> <a href="${escapeHtml(update.workLink.issueUrl)}" rel="noreferrer">${escapeHtml(update.workLink.issueId)}</a> · ${escapeHtml(update.workLink.status)} · ${escapeHtml(update.workLink.action)}</p>`
    : '<p class="empty">No existing work link was present when this update was confirmed.</p>';
  return `<ol class="outcome-history">${history.updates.map((update) => `<li><h4>Update ${update.updateNumber}</h4><p><strong>Status:</strong> ${escapeHtml(update.status)} · <strong>Follow-up decision:</strong> ${escapeHtml(update.followUpDecision)}</p><dl><dt>Observed result</dt><dd>${escapeHtml(update.observedResult)}</dd><dt>Measurement or user-supplied evidence</dt><dd>${escapeHtml(update.measurementEvidence)}</dd><dt>Unexpected effects</dt><dd>${escapeHtml(update.unexpectedEffects)}</dd></dl>${workLink(update)}<p class="provenance">${escapeHtml(update.provenance.source)} · ${escapeHtml(update.provenance.confirmation)} · ${escapeHtml(update.provenance.confirmedAt)}</p></li>`).join("")}</ol>`;
}

function outcomeHistorySections(store) {
  return Object.values(store.histories)
    .sort((first, second) => first.origin.recommendationNumber - second.origin.recommendationNumber)
    .map((history) => `<article class="outcome-origin"><h3>Recommendation ${history.origin.recommendationNumber}</h3><p>Originating pseudonymous citations (not outcome evidence): ${history.origin.evidenceReferences.map(escapeHtml).join(", ")}.</p>${outcomeRows(history)}</article>`)
    .join("");
}

/** Safe rendering labels outcome text as user context, never source evidence for claims. */
export function renderHindsightOutcomeHistoryHtml(history, { heading = "User-observed outcome history", priorContext = false } = {}) {
  const store = parseHindsightOutcomeHistory(history);
  const context = priorContext
    ? "Deliberately supplied prior-outcome context. It is user-observed/user-confirmed context, not source evidence and must not support unrelated claims."
    : "User-observed/user-confirmed local outcome history. It is not model inference or source evidence for unrelated claims.";
  return `<section class="hindsight-outcomes" aria-labelledby="hindsight-outcomes-heading"><h2 id="hindsight-outcomes-heading">${escapeHtml(heading)}</h2><p class="outcome-notice">${context}</p><p class="outcome-origin">Report: ${escapeHtml(store.reportId)}.</p>${outcomeHistorySections(store)}</section>`;
}

export function renderHindsightOutcomeHistoryDocumentHtml(history) {
  const body = renderHindsightOutcomeHistoryHtml(history, { heading: "Hindsight recommendation outcome history" });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Pi hindsight outcome history</title><style>:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#1a1b26;color:#c0caf5}body{margin:0 auto;max-width:64rem;padding:2rem;line-height:1.45}.hindsight-outcomes,.outcome-history li,.outcome-origin{background:#24283b;border:1px solid #414868;border-radius:.5rem;margin:1rem 0;padding:1rem}.outcome-history{padding-left:1.5rem}.outcome-history li{margin:.75rem 0}.outcome-history h4{margin-top:0}.outcome-history dt{font-weight:700;margin-top:.75rem}.outcome-history dd{margin-left:0;white-space:pre-wrap;overflow-wrap:anywhere}.empty,.outcome-notice{color:#a9b1d6}.provenance{font-size:.9rem;font-weight:700}.outcome-origin{overflow-wrap:anywhere}a:focus-visible{outline:2px solid #7aa2f7;outline-offset:2px}</style></head><body><main>${body}</main></body></html>`;
}

/** Atomic replacement used only while a report-scoped outcome lock is held. */
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

/** Appends and refreshes both inspectable reports inside one cross-process transaction. */
export async function recordHindsightOutcomeUpdate(path, origin, update, { reportPath, outcomeReportPath }) {
  if (typeof reportPath !== "string" || typeof outcomeReportPath !== "string") throw new HindsightOutcomeError("invalid_disposition_path");
  return withHindsightOutcomeLock(path, async () => {
    const store = await appendHindsightOutcomeUpdateUnlocked(path, origin, update);
    try {
      await writeHindsightOutcomeHistoryReport(outcomeReportPath, store);
      await refreshHindsightReportOutcomeHistory(reportPath, store);
    } catch {
      // JSON is the durable source of truth after the append; never imply a
      // retry is safe merely because an inspectable HTML refresh failed.
      throw new HindsightOutcomeError("outcome_report_refresh_failed");
    }
    return store;
  });
}
