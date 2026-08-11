import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { escapeHtml } from "./catalog.mjs";
import { parseHindsightOutcomeHistory, withHindsightReportRefreshLock } from "./hindsight-outcomes.mjs";

const REPORT_ID = /^hindsight-[a-f0-9]{8}$/;
const CITATION = /^session-[a-z0-9]+:event-[0-9]{4}$/;
const TARGET_ID = /^(?:claim|recommendation)-[a-f0-9]{16}$/;
const CLASSIFICATIONS = new Set(["helpful", "incorrect", "overstated", "incomplete", "not-actionable"]);
const FEEDBACK_LOCK_TIMEOUT_MS = 10_000;
const STALE_FEEDBACK_LOCK_MS = 60_000;
const feedbackLocks = new Map();

export class HindsightFeedbackError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const ownObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => ownObject(value) && Object.keys(value).every((key) => keys.includes(key));
const validTimestamp = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

function boundedText(value, maxLength, code = "malformed_feedback") {
  if (typeof value !== "string") throw new HindsightFeedbackError(code);
  const text = value.trim();
  if (!text || Array.from(text).length > maxLength) throw new HindsightFeedbackError(code);
  return text;
}

// Durable user feedback must not become a surrogate transcript or credential store.
const UNSAFE_FEEDBACK_TEXT = /\b(?:raw[- ]?session(?:[- ]?id)?|session[_-]?id|pi_session_file|bearer\s+|api[_-]?key|authorization\s*:|gh[pousr]_[A-Za-z0-9_]{20,}|(?:akia|asia|aida|aroa)[a-z0-9]{16}|(?:aws_)?(?:secret_access_key|access_key_id)\s*[:=]|(?:password|secret|token|credential)s?\s*(?:=|:)\s*\S+)\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function safeFeedbackText(value) {
  const text = boundedText(value, 2000);
  if (UNSAFE_FEEDBACK_TEXT.test(text)) throw new HindsightFeedbackError("unsafe_feedback_text");
  return text;
}

function boundedReferences(value, code = "malformed_feedback") {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new HindsightFeedbackError(code);
  const references = value.map((reference) => boundedText(reference, 100, code));
  if (new Set(references).size !== references.length || references.some((reference) => !CITATION.test(reference))) {
    throw new HindsightFeedbackError(code);
  }
  return references;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function targetFor(reportId, type, statement, references) {
  const normalizedStatement = boundedText(statement, type === "claim" ? 2000 : 1000, "invalid_feedback_target");
  const evidenceReferences = boundedReferences(references, "invalid_feedback_target");
  const textDigest = digest({ reportId, type, statement: normalizedStatement, evidenceReferences });
  return {
    targetId: `${type}-${textDigest.slice(0, 16)}`,
    type,
    textDigest,
    modelProvenance: type === "claim" ? "model-generated" : "model-suggestion",
    evidenceReferences,
  };
}

/** Creates immutable feedback targets without persisting claim/recommendation text. */
export function createHindsightFeedbackMetadata(document) {
  const reportId = document?.reportId;
  if (!REPORT_ID.test(reportId)) throw new HindsightFeedbackError("invalid_feedback_target");
  const claims = Array.isArray(document?.claims) ? document.claims : [];
  const recommendations = Array.isArray(document?.recommendations) ? document.recommendations : [];
  const targets = [
    ...claims.filter((claim) => claim?.validationExcluded !== true).map((claim) => targetFor(reportId, "claim", claim?.statement, claim?.evidenceReferences || claim?.references)),
    ...recommendations.map((recommendation) => targetFor(reportId, "recommendation", recommendation?.recommendation, recommendation?.evidenceReferences || recommendation?.references)),
  ];
  if (targets.length > 120 || new Set(targets.map((target) => target.targetId)).size !== targets.length) {
    throw new HindsightFeedbackError("invalid_feedback_target");
  }
  return { schemaVersion: 1, kind: "pi-hindsight-report-feedback", reportId, targets, feedback: [] };
}

function normalizeTarget(value, code = "malformed_feedback") {
  if (!exactKeys(value, ["targetId", "type", "textDigest", "modelProvenance", "evidenceReferences"])
    || typeof value.targetId !== "string" || !TARGET_ID.test(value.targetId)
    || typeof value.type !== "string" || !["claim", "recommendation"].includes(value.type)
    || typeof value.textDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.textDigest)
    || value.targetId !== `${value.type}-${value.textDigest.slice(0, 16)}`
    || value.modelProvenance !== (value.type === "claim" ? "model-generated" : "model-suggestion")) {
    throw new HindsightFeedbackError(code);
  }
  return { targetId: value.targetId, type: value.type, textDigest: value.textDigest, modelProvenance: value.modelProvenance, evidenceReferences: boundedReferences(value.evidenceReferences, code) };
}

function normalizeFeedback(value, expectedNumber, targets) {
  if (!exactKeys(value, ["feedbackNumber", "targetId", "classification", "correctedFraming", "provenance"])
    || !Number.isInteger(value.feedbackNumber) || value.feedbackNumber !== expectedNumber
    || typeof value.targetId !== "string" || !targets.has(value.targetId)
    || typeof value.classification !== "string" || !CLASSIFICATIONS.has(value.classification)
    || !exactKeys(value.provenance, ["source", "confirmation", "recordedAt"])
    || value.provenance.source !== "user-feedback" || value.provenance.confirmation !== "user-confirmed"
    || !validTimestamp(value.provenance.recordedAt)) throw new HindsightFeedbackError("malformed_feedback");
  if (value.correctedFraming !== undefined && value.correctedFraming !== "") safeFeedbackText(value.correctedFraming);
  if (value.correctedFraming !== undefined && typeof value.correctedFraming !== "string") throw new HindsightFeedbackError("malformed_feedback");
  return {
    feedbackNumber: value.feedbackNumber,
    targetId: value.targetId,
    classification: value.classification,
    ...(value.correctedFraming ? { correctedFraming: safeFeedbackText(value.correctedFraming) } : {}),
    provenance: { source: "user-feedback", confirmation: "user-confirmed", recordedAt: value.provenance.recordedAt },
  };
}

/** Strictly parses the versioned local-only feedback store. */
export function parseHindsightFeedback(value) {
  if (!exactKeys(value, ["schemaVersion", "kind", "reportId", "targets", "feedback"])
    || value.schemaVersion !== 1 || value.kind !== "pi-hindsight-report-feedback"
    || typeof value.reportId !== "string" || !REPORT_ID.test(value.reportId)
    || !Array.isArray(value.targets) || value.targets.length > 120
    || !Array.isArray(value.feedback) || value.feedback.length > 500) throw new HindsightFeedbackError("malformed_feedback");
  const targets = value.targets.map((target) => normalizeTarget(target));
  const targetIds = new Set(targets.map((target) => target.targetId));
  if (targetIds.size !== targets.length) throw new HindsightFeedbackError("malformed_feedback");
  return {
    schemaVersion: 1,
    kind: "pi-hindsight-report-feedback",
    reportId: value.reportId,
    targets,
    feedback: value.feedback.map((entry, index) => normalizeFeedback(entry, index + 1, targetIds)),
  };
}

export function feedbackPathForDispositionPath(path) {
  if (typeof path !== "string" || path.includes("\0") || !path.endsWith(".dispositions.json")) throw new HindsightFeedbackError("invalid_feedback_path");
  return path.replace(/\.dispositions\.json$/, ".feedback.json");
}

export function feedbackReportPathForDispositionPath(path) {
  if (typeof path !== "string" || path.includes("\0") || !path.endsWith(".dispositions.json")) throw new HindsightFeedbackError("invalid_feedback_path");
  return path.replace(/\.dispositions\.json$/, ".feedback.html");
}

export async function readHindsightFeedback(path) {
  try { return parseHindsightFeedback(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof HindsightFeedbackError) throw error;
    throw new HindsightFeedbackError("malformed_feedback");
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const lockOwnerPath = (lockPath) => `${lockPath}/owner.json`;

function lockOwner(value) {
  return ownObject(value) && value.schemaVersion === 1 && typeof value.token === "string" && /^[a-f0-9-]{36}$/.test(value.token)
    && Number.isInteger(value.pid) && value.pid > 0 && validTimestamp(value.createdAt) ? value : undefined;
}

function lockIsActive(pid, processAlive = (candidate) => {
  try { process.kill(candidate, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}) {
  return processAlive(pid) === true;
}

async function staleLockCandidate(lockPath, { readFileImpl, statImpl, now, staleMs, processAlive }) {
  let owner;
  try { owner = lockOwner(JSON.parse(await readFileImpl(lockOwnerPath(lockPath), "utf8"))); } catch { /* A crashed creator can leave no owner file. */ }
  if (owner) {
    if (now() - Date.parse(owner.createdAt) < staleMs || lockIsActive(owner.pid, processAlive)) return false;
    return true;
  }
  try {
    const details = await statImpl(lockPath);
    return now() - details.mtimeMs >= staleMs;
  } catch { return false; }
}

/**
 * Acquires a feedback lock with a nonce owner record. Only an old lock whose
 * recorded owner is no longer alive (or ownerless old directory) is atomically
 * renamed aside before removal; active owners are never removed by a waiter.
 */
export async function acquireCrossProcessFeedbackLock(path, {
  mkdirImpl = mkdir,
  readFileImpl = readFile,
  statImpl = stat,
  renameImpl = rename,
  rmImpl = rm,
  delayImpl = delay,
  now = () => Date.now(),
  processAlive,
  randomUUIDImpl = randomUUID,
  timeoutMs = FEEDBACK_LOCK_TIMEOUT_MS,
  staleMs = STALE_FEEDBACK_LOCK_MS,
} = {}) {
  const lockPath = `${path}.lock`;
  await mkdirImpl(dirname(lockPath), { recursive: true });
  const deadline = now() + timeoutMs;
  let wait = 5;
  while (true) {
    const token = randomUUIDImpl();
    try {
      await mkdirImpl(lockPath);
      const owner = { schemaVersion: 1, token, pid: process.pid, createdAt: new Date(now()).toISOString() };
      await writeFile(lockOwnerPath(lockPath), `${JSON.stringify(owner)}\n`, "utf8");
      return { lockPath, token };
    } catch (error) {
      const transient = error?.code === "EEXIST" || (error?.code === "EPERM" && error?.syscall === "mkdir" && error?.path === lockPath);
      if (!transient) throw error;
      if (await staleLockCandidate(lockPath, { readFileImpl, statImpl, now, staleMs, processAlive })) {
        const quarantined = `${lockPath}.stale-${randomUUIDImpl()}`;
        try {
          await renameImpl(lockPath, quarantined);
          await rmImpl(quarantined, { recursive: true, force: true });
          continue;
        } catch { /* Another contender changed the path; re-check without deleting it. */ }
      }
      if (now() >= deadline) throw new HindsightFeedbackError("feedback_lock_timeout");
      await delayImpl(wait); wait = Math.min(wait * 2, 100);
    }
  }
}

async function releaseCrossProcessFeedbackLock(lock, { readFileImpl = readFile, rmImpl = rm } = {}) {
  try {
    const owner = lockOwner(JSON.parse(await readFileImpl(lockOwnerPath(lock.lockPath), "utf8")));
    if (owner?.token === lock.token) await rmImpl(lock.lockPath, { recursive: true, force: true });
  } catch { /* A reclaimed/missing lock must not cause removal of another owner. */ }
}

async function withFeedbackLock(path, operation) {
  if (typeof path !== "string" || !path || path.includes("\0")) throw new HindsightFeedbackError("invalid_feedback_path");
  const previous = feedbackLocks.get(path) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  feedbackLocks.set(path, current);
  await previous;
  let lock;
  try { lock = await acquireCrossProcessFeedbackLock(path); return await operation(); }
  finally {
    if (lock) await releaseCrossProcessFeedbackLock(lock);
    release();
    if (feedbackLocks.get(path) === current) feedbackLocks.delete(path);
  }
}

async function atomicWrite(path, content) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, content, "utf8");
  try { await rename(temporaryPath, path); }
  catch (error) { await rm(temporaryPath, { force: true }).catch(() => undefined); throw error; }
}

async function appendHindsightFeedbackUnlocked(path, targetId, entry) {
  const store = await readHindsightFeedback(path);
  if (!store) throw new HindsightFeedbackError("feedback_missing");
  const feedback = normalizeFeedback({ ...entry, feedbackNumber: store.feedback.length + 1, targetId }, store.feedback.length + 1, new Set(store.targets.map((target) => target.targetId)));
  const replacement = { ...store, feedback: [...store.feedback, feedback] };
  await atomicWrite(path, `${JSON.stringify(replacement, null, 2)}\n`);
  return replacement;
}

/** Adds one confirmed feedback record to an immutable target in an atomic store. */
export async function appendHindsightFeedback(path, targetId, entry) {
  return withFeedbackLock(path, () => appendHindsightFeedbackUnlocked(path, targetId, entry));
}

/** Keeps only current report targets; removed items cannot remain selectable. */
export async function writeHindsightFeedbackSeed(path, seed) {
  const next = parseHindsightFeedback(seed);
  return withFeedbackLock(path, async () => {
    const previous = await readHindsightFeedback(path);
    if (!previous || previous.reportId !== next.reportId) {
      await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    }
    const currentTargetIds = new Set(next.targets.map((target) => target.targetId));
    const merged = parseHindsightFeedback({ ...next, targets: next.targets, feedback: previous.feedback.filter((entry) => currentTargetIds.has(entry.targetId)) });
    await atomicWrite(path, `${JSON.stringify(merged, null, 2)}\n`);
    return merged;
  });
}

function localDispositionSummary(value, reportId) {
  if (!exactKeys(value, ["schemaVersion", "kind", "reportId", "provenance", "recommendations", "exportedAt"])
    && !exactKeys(value, ["schemaVersion", "kind", "reportId", "provenance", "recommendations"])) return undefined;
  if (value.schemaVersion !== 2 || value.kind !== "pi-hindsight-recommendation-dispositions" || value.reportId !== reportId || !Array.isArray(value.recommendations)) return undefined;
  const counts = { accepted: 0, deferred: 0, rejected: 0, notRecorded: 0 };
  for (const recommendation of value.recommendations) {
    const disposition = recommendation?.userDisposition;
    if (!exactKeys(disposition, ["status", "source", "rationale"]) && !exactKeys(disposition, ["status", "source", "rationale", "confirmedAt"])) return undefined;
    if (disposition.status === "not-recorded" && disposition.source === "not-user-confirmed") counts.notRecorded += 1;
    else if (["accepted", "deferred", "rejected"].includes(disposition.status) && disposition.source === "user-confirmed") counts[disposition.status] += 1;
    else return undefined;
  }
  return counts;
}

/** Aggregates only local user records. Nothing here is model evidence or prompt input. */
function rate(count, denominator) {
  return { count, denominator, value: denominator === 0 ? 0 : count / denominator };
}

export function aggregateHindsightFeedback(store, { dispositions, outcomes } = {}) {
  const parsed = parseHindsightFeedback(store);
  const classifications = Object.fromEntries([...CLASSIFICATIONS].map((classification) => [classification, 0]));
  for (const entry of parsed.feedback) classifications[entry.classification] += 1;
  const recordedFeedback = parsed.feedback.length;
  const classificationRates = Object.fromEntries(Object.entries(classifications).map(([classification, count]) => [classification, rate(count, recordedFeedback)]));
  const corrected = parsed.feedback.filter((entry) => Boolean(entry.correctedFraming)).length;
  const correctionRate = rate(corrected, recordedFeedback);
  const dispositionCounts = dispositions === undefined ? undefined : localDispositionSummary(dispositions, parsed.reportId);
  if (dispositions !== undefined && !dispositionCounts) throw new HindsightFeedbackError("aggregate_metadata_malformed");
  const disposition = dispositionCounts && {
    ...dispositionCounts,
    total: Object.values(dispositionCounts).reduce((sum, count) => sum + count, 0),
  };
  if (disposition) disposition.acceptanceRate = rate(disposition.accepted, disposition.total);
  let outcome;
  if (outcomes !== undefined) {
    let parsedOutcomes;
    try { parsedOutcomes = parseHindsightOutcomeHistory(outcomes); }
    catch { throw new HindsightFeedbackError("aggregate_metadata_malformed"); }
    if (parsedOutcomes.reportId !== parsed.reportId) throw new HindsightFeedbackError("aggregate_metadata_mismatch");
    const histories = Object.values(parsedOutcomes.histories);
    const updates = histories.flatMap((history) => history.updates);
    const statusCounts = { "not-started": 0, "in-progress": 0, completed: 0, paused: 0, stopped: 0 };
    for (const update of updates) statusCounts[update.status] += 1;
    outcome = {
      recordedUpdates: updates.length,
      statusCounts,
      statusRates: Object.fromEntries(Object.entries(statusCounts).map(([status, count]) => [status, rate(count, updates.length)])),
      recordedOutcomeRate: disposition ? rate(histories.filter((history) => history.updates.length > 0).length, disposition.accepted) : undefined,
    };
  }
  return { classifications, classificationRates, recordedFeedback, corrected, correctionRate, disposition, outcome };
}

function displayRate(value) {
  return `${value.count}/${value.denominator} (${Math.round(value.value * 100)}%)`;
}

function aggregateHtml(aggregate) {
  const feedbackRows = Object.entries(aggregate.classificationRates).map(([name, value]) => `<li><strong>${escapeHtml(name)}:</strong> ${displayRate(value)}</li>`).join("");
  const disposition = aggregate.disposition
    ? `<p><strong>User disposition acceptance rate:</strong> ${displayRate(aggregate.disposition.acceptanceRate)}; deferred ${aggregate.disposition.deferred}/${aggregate.disposition.total}; rejected ${aggregate.disposition.rejected}/${aggregate.disposition.total}; not recorded ${aggregate.disposition.notRecorded}/${aggregate.disposition.total}.</p>`
    : '<p class="empty">User disposition acceptance rate is unavailable until a valid local disposition export is present.</p>';
  const outcome = aggregate.outcome
    ? `<p><strong>Recorded outcome status rates:</strong> ${Object.entries(aggregate.outcome.statusRates).map(([status, value]) => `${escapeHtml(status)} ${displayRate(value)}`).join("; ")}.${aggregate.outcome.recordedOutcomeRate ? ` <strong>Accepted recommendations with a recorded outcome:</strong> ${displayRate(aggregate.outcome.recordedOutcomeRate)}.` : ""}</p>`
    : '<p class="empty">Recorded outcome rates are unavailable until a valid local outcome store is present.</p>';
  return `<section class="hindsight-feedback" aria-labelledby="hindsight-feedback-heading"><h2 id="hindsight-feedback-heading">Local feedback and calibration signals</h2><p class="feedback-notice">These are user-provided, local operational signals. They are not model evidence, citations, or prompt input.</p><p><strong>Recorded feedback:</strong> ${aggregate.recordedFeedback}; <strong>corrected framing rate:</strong> ${displayRate(aggregate.correctionRate)}.</p><ul>${feedbackRows}</ul>${disposition}${outcome}</section>`;
}

export function renderHindsightFeedbackHtml(store, options = {}) {
  return aggregateHtml(aggregateHindsightFeedback(store, options));
}

export function renderHindsightFeedbackDocumentHtml(store, options = {}) {
  const parsed = parseHindsightFeedback(store);
  const body = renderHindsightFeedbackHtml(parsed, options);
  const entries = parsed.feedback.length === 0
    ? '<p class="empty" role="status">No local feedback entries are recorded.</p>'
    : `<section class="feedback-entries" aria-labelledby="feedback-entries-heading"><h2 id="feedback-entries-heading">Recorded local feedback</h2><ol>${parsed.feedback.map((entry) => `<li><p><strong>${escapeHtml(entry.classification)}</strong> · target ${escapeHtml(entry.targetId)} · ${escapeHtml(entry.provenance.source)} · ${escapeHtml(entry.provenance.confirmation)} · ${escapeHtml(entry.provenance.recordedAt)}</p>${entry.correctedFraming ? `<p><strong>Corrected framing:</strong> ${escapeHtml(entry.correctedFraming)}</p>` : '<p class="empty">No corrected framing supplied.</p>'}</li>`).join("")}</ol></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Pi hindsight feedback</title><style>:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#1a1b26;color:#c0caf5}body{margin:0 auto;max-width:64rem;padding:2rem;line-height:1.45}.hindsight-feedback,.feedback-entries,.feedback-entries li{background:#24283b;border:1px solid #414868;border-radius:.5rem;padding:1rem}.feedback-entries{margin-top:1rem}.feedback-entries li{margin:.75rem 0;overflow-wrap:anywhere}.feedback-notice,.empty{color:#a9b1d6}.hindsight-feedback li{overflow-wrap:anywhere}strong{font-weight:700}</style></head><body><main>${body}${entries}</main></body></html>`;
}

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw new HindsightFeedbackError("aggregate_metadata_malformed"); }
}

async function refreshReport(path, html) {
  const source = await readFile(path, "utf8");
  const marker = /<!-- pi-hindsight-feedback:start -->[\s\S]*?<!-- pi-hindsight-feedback:end -->/g;
  const matches = source.match(marker);
  if (!matches || matches.length !== 1) throw new HindsightFeedbackError("feedback_report_marker_missing");
  await atomicWrite(path, source.replace(marker, `<!-- pi-hindsight-feedback:start -->${html}<!-- pi-hindsight-feedback:end -->`));
}

/** Rebuilds safe local-only calibration views from the durable feedback source. */
export async function refreshHindsightFeedbackViews(path, { reportPath, feedbackReportPath, dispositionPath, outcomePath }) {
  return withFeedbackLock(path, async () => {
    const [dispositions, outcomes, store] = await Promise.all([optionalJson(dispositionPath), optionalJson(outcomePath), readHindsightFeedback(path)]);
    if (!store) throw new HindsightFeedbackError("feedback_missing");
    const aggregate = aggregateHindsightFeedback(store, { dispositions, outcomes });
    await atomicWrite(feedbackReportPath, renderHindsightFeedbackDocumentHtml(store, { dispositions, outcomes }));
    await withHindsightReportRefreshLock(reportPath, () => refreshReport(reportPath, aggregateHtml(aggregate)));
    return store;
  });
}

/** Writes durable feedback first, then refreshes safe report-only calibration views. */
export async function recordHindsightFeedback(path, targetId, entry, { reportPath, feedbackReportPath, dispositionPath, outcomePath }) {
  return withFeedbackLock(path, async () => {
    try {
      // Validate optional local aggregate inputs before the append so malformed
      // or old metadata cannot cause a partially accepted feedback operation.
      const [dispositions, outcomes, current] = await Promise.all([optionalJson(dispositionPath), optionalJson(outcomePath), readHindsightFeedback(path)]);
      if (!current) throw new HindsightFeedbackError("feedback_missing");
      aggregateHindsightFeedback(current, { dispositions, outcomes });
      const store = await appendHindsightFeedbackUnlocked(path, targetId, entry);
      const aggregate = aggregateHindsightFeedback(store, { dispositions, outcomes });
      await atomicWrite(feedbackReportPath, renderHindsightFeedbackDocumentHtml(store, { dispositions, outcomes }));
      await withHindsightReportRefreshLock(reportPath, () => refreshReport(reportPath, aggregateHtml(aggregate)));
      return store;
    } catch (error) {
      if (error instanceof HindsightFeedbackError) throw error;
      throw new HindsightFeedbackError("feedback_report_refresh_failed");
    }
  });
}
