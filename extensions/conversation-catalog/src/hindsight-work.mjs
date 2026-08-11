import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ENV_REFERENCE = /^\$[A-Z][A-Z0-9_]{0,127}$/;
const REPORT_ID = /^hindsight-[a-f0-9]{8}$/;
const TEAM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISSUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CITATION = /^session-[a-z0-9]+:event-[0-9]{4}$/;
const OFFICIAL_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const PRIORITIES = new Set(["critical", "high", "medium", "low"]);
// Commands execute in one Pi process. This per-backlink-file FIFO prevents
// concurrent command invocations for different recommendations from racing the
// shared read/check/mutate/write record. Entries are deleted in finally.
const workLinkLocks = new Map();

export const HINDSIGHT_WORK_CONFIG_PATH = ".pi/hindsight-linear.json";

export class HindsightWorkError extends Error {
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

function boundedText(value, maxLength, code) {
  if (typeof value !== "string") throw new HindsightWorkError(code);
  const text = value.trim();
  if (!text || Array.from(text).length > maxLength) throw new HindsightWorkError(code);
  return text;
}

function boundedTextArray(value, maxItems, maxLength, code, { minimum = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maxItems) throw new HindsightWorkError(code);
  return value.map((item) => boundedText(item, maxLength, code));
}

function validTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

/** Validates the only trusted-project configuration accepted by this adapter. */
export function validateHindsightWorkContext({ hasUI, trusted } = {}) {
  if (hasUI !== true) throw new HindsightWorkError("ui_required");
  if (trusted !== true) throw new HindsightWorkError("untrusted_project");
}

/** Caller must invoke this immediately before the requested remote/local action. */
export function requireFinalHindsightWorkConfirmation(confirmed) {
  if (confirmed !== true) throw new HindsightWorkError("confirmation_required");
}

export function validateHindsightLinearConfig(value, { env = process.env } = {}) {
  if (!exactKeys(value, ["teamId", "endpoint", "tokenEnvRef"])) return { ok: false, code: "invalid_config" };
  if (typeof value.teamId !== "string" || !TEAM_ID.test(value.teamId)) return { ok: false, code: "invalid_team_id" };
  if (value.endpoint !== OFFICIAL_LINEAR_ENDPOINT) return { ok: false, code: "invalid_endpoint" };
  if (typeof value.tokenEnvRef !== "string" || !ENV_REFERENCE.test(value.tokenEnvRef)) return { ok: false, code: "invalid_token_reference" };
  const token = env[value.tokenEnvRef.slice(1)];
  if (typeof token !== "string" || !token.trim()) return { ok: false, code: "missing_token" };
  return { ok: true, config: { teamId: value.teamId, endpoint: value.endpoint, tokenEnvRef: value.tokenEnvRef }, token };
}

function normalizeDisposition(item, expectedNumber) {
  if (!exactKeys(item, ["recommendationNumber", "modelSuggestion", "userDisposition"])) {
    throw new HindsightWorkError("malformed_metadata");
  }
  if (!Number.isInteger(item.recommendationNumber) || item.recommendationNumber !== expectedNumber) {
    throw new HindsightWorkError("malformed_metadata");
  }
  const model = item.modelSuggestion;
  if (!exactKeys(model, ["status", "source", "recommendation", "priority", "expectedImpact", "suggestedOwner", "dependencies", "acceptanceCriteria", "evidenceReferences"])
    || model.status !== "proposed" || model.source !== "model-suggestion") {
    throw new HindsightWorkError("malformed_metadata");
  }
  const priority = boundedText(model.priority, 16, "malformed_metadata");
  if (!PRIORITIES.has(priority)) throw new HindsightWorkError("malformed_metadata");
  const references = boundedTextArray(model.evidenceReferences, 20, 100, "malformed_metadata", { minimum: 1 });
  if (new Set(references).size !== references.length || references.some((reference) => !CITATION.test(reference))) {
    throw new HindsightWorkError("malformed_metadata");
  }
  const user = item.userDisposition;
  if (!exactKeys(user, ["status", "source", "rationale", "confirmedAt"])
    || !["accepted", "deferred", "rejected"].includes(user.status)
    || user.source !== "user-confirmed" || !validTimestamp(user.confirmedAt)) {
    throw new HindsightWorkError("malformed_metadata");
  }
  return {
    recommendationNumber: item.recommendationNumber,
    recommendation: boundedText(model.recommendation, 1000, "malformed_metadata"),
    priority,
    expectedImpact: boundedText(model.expectedImpact, 500, "malformed_metadata"),
    suggestedOwner: boundedText(model.suggestedOwner, 200, "malformed_metadata"),
    dependencies: boundedTextArray(model.dependencies, 20, 200, "malformed_metadata"),
    acceptanceCriteria: boundedTextArray(model.acceptanceCriteria, 20, 500, "malformed_metadata", { minimum: 1 }),
    evidenceReferences: references,
    userDisposition: {
      status: user.status,
      source: user.source,
      // The rationale is validated as a local confirmation record but is never
      // part of an external work-item payload.
      rationale: boundedText(user.rationale, 1000, "malformed_metadata"),
      confirmedAt: user.confirmedAt,
    },
  };
}

/**
 * Strictly parses the enriched, user-exported disposition metadata. Version 1
 * exports deliberately fail: they lack the immutable work fields and must not
 * be completed from report text or user input.
 */
export function parseHindsightWorkDispositions(value) {
  if (!exactKeys(value, ["schemaVersion", "kind", "reportId", "provenance", "exportedAt", "recommendations"])
    || value.schemaVersion !== 2 || value.kind !== "pi-hindsight-recommendation-dispositions"
    || typeof value.reportId !== "string" || !REPORT_ID.test(value.reportId)
    || !validTimestamp(value.exportedAt) || !exactKeys(value.provenance, ["modelSuggestions", "userDispositions"])
    || value.provenance.modelSuggestions !== "model-suggestion" || value.provenance.userDispositions !== "user-confirmed"
    || !Array.isArray(value.recommendations) || value.recommendations.length < 1 || value.recommendations.length > 40) {
    throw new HindsightWorkError("malformed_metadata");
  }
  const recommendations = value.recommendations.map((item, index) => normalizeDisposition(item, index + 1));
  return { reportId: value.reportId, recommendations };
}

export function acceptedHindsightRecommendations(metadata) {
  const accepted = metadata.recommendations.filter((recommendation) => recommendation.userDisposition.status === "accepted");
  if (accepted.length === 0) throw new HindsightWorkError("no_accepted_recommendations");
  return accepted;
}

function list(items) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None specified";
}

const priorityNumber = Object.freeze({ critical: 1, high: 2, medium: 3, low: 4 });

/** Builds the complete, source-excerpt-free create payload from one accepted recommendation. */
export function buildLinearIssueCreatePayload(teamId, reportId, recommendation) {
  if (!TEAM_ID.test(teamId) || !REPORT_ID.test(reportId) || !recommendation || recommendation.userDisposition?.status !== "accepted") {
    throw new HindsightWorkError("malformed_metadata");
  }
  const description = [
    "Hindsight recommendation (user-confirmed)",
    "",
    "Recommendation:", recommendation.recommendation,
    "",
    `Priority (model suggestion): ${recommendation.priority}`,
    "Expected impact:", recommendation.expectedImpact,
    "Suggested owner (text only; no assignment):", recommendation.suggestedOwner,
    "Dependencies:", list(recommendation.dependencies),
    "Acceptance criteria:", list(recommendation.acceptanceCriteria),
    "Provenance:",
    `- local report: ${reportId}`,
    "- model suggestion: proposed · model-suggestion",
    "- user disposition: accepted · user-confirmed",
    "Pseudonymous evidence citations:", list(recommendation.evidenceReferences),
  ].join("\n");
  return {
    teamId,
    title: recommendation.recommendation,
    description,
    priority: priorityNumber[recommendation.priority],
  };
}

export function digestHindsightWorkPayload(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function workLinkKey(reportId, recommendationNumber) {
  return `${reportId}:recommendation-${recommendationNumber}`;
}

/** Serializes the complete side-effect transaction for one shared backlink file. */
export async function withHindsightWorkBacklinkLock(backlinkPath, operation) {
  if (typeof backlinkPath !== "string" || !backlinkPath) throw new HindsightWorkError("invalid_disposition_path");
  const previous = workLinkLocks.get(backlinkPath) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  workLinkLocks.set(backlinkPath, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    // Do not remove a successor that queued while this operation was running.
    if (workLinkLocks.get(backlinkPath) === current) workLinkLocks.delete(backlinkPath);
  }
}

export function workLinksPathForDispositionPath(dispositionPath) {
  if (typeof dispositionPath !== "string" || !dispositionPath.endsWith(".dispositions.json")) {
    throw new HindsightWorkError("invalid_disposition_path");
  }
  return dispositionPath.replace(/\.dispositions\.json$/, ".work-links.json");
}

function validateStoredLink(value) {
  return exactKeys(value, ["issueId", "issueUrl", "status", "timestamp", "payloadDigest", "action"])
    && typeof value.issueId === "string" && ISSUE_ID.test(value.issueId)
    && typeof value.issueUrl === "string" && isHttpsUrl(value.issueUrl)
    && typeof value.status === "string" && value.status.trim().length > 0 && Array.from(value.status).length <= 160
    && validTimestamp(value.timestamp) && typeof value.payloadDigest === "string" && /^[a-f0-9]{64}$/.test(value.payloadDigest)
    && (value.action === "created" || value.action === "linked");
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.href === value;
  } catch {
    return false;
  }
}

export async function readHindsightWorkLinks(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!exactKeys(parsed, ["schemaVersion", "kind", "links"]) || parsed.schemaVersion !== 1
      || parsed.kind !== "pi-hindsight-work-links" || !ownObject(parsed.links)
      || Object.entries(parsed.links).some(([key, link]) => !/^hindsight-[a-f0-9]{8}:recommendation-[1-9][0-9]*$/.test(key) || !validateStoredLink(link))) {
      throw new HindsightWorkError("invalid_work_links");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: 1, kind: "pi-hindsight-work-links", links: {} };
    if (error instanceof HindsightWorkError) throw error;
    throw new HindsightWorkError("invalid_work_links");
  }
}

/** Writes a successful remote result without ever replacing an existing link key. */
export async function writeHindsightWorkLink(path, reportId, recommendationNumber, link) {
  const stored = await readHindsightWorkLinks(path);
  const key = workLinkKey(reportId, recommendationNumber);
  if (stored.links[key]) throw new HindsightWorkError("duplicate_link");
  if (!validateStoredLink(link)) throw new HindsightWorkError("invalid_work_link");
  const replacement = { ...stored, links: { ...stored.links, [key]: link } };
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(replacement, null, 2)}\n`, "utf8");
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function isValidExistingIssueId(value) {
  return typeof value === "string" && ISSUE_ID.test(value);
}
