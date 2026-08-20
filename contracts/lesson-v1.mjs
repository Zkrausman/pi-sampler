import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

export const LESSON_V1_SCHEMA_ID = "https://pi-sampler.dev/contracts/lesson/v1";
export const LESSON_V1_SCHEMA_VERSION = "1.0.0";
export const LESSON_LIFECYCLE_STATES = Object.freeze([
  "proposed",
  "evaluated",
  "promoted",
  "monitored",
  "reverted",
  "retired",
  "superseded",
  "rejected",
]);
export const LESSON_BEHAVIOR_KINDS = Object.freeze(["repeat", "avoid", "test"]);
export const LESSON_RISK_LEVELS = Object.freeze(["low", "medium", "high", "critical"]);
// Short aliases keep consumers from having to couple to the descriptive
// constant names while preserving one canonical state list.
export const LESSON_STATES = LESSON_LIFECYCLE_STATES;
export const LESSON_SCHEMA_ID = LESSON_V1_SCHEMA_ID;
export const LESSON_SCHEMA_VERSION = LESSON_V1_SCHEMA_VERSION;
export const LESSON_EVIDENCE_KINDS = Object.freeze(["supporting", "human_decision", "evaluation", "counterevidence"]);
export const DEFAULT_LESSON_LIMITS = Object.freeze({
  maxLessonBytes: 256 * 1024,
  maxConditions: 64,
  maxEvidence: 128,
  maxAnnotations: 128,
  maxCounterevidence: 128,
  maxHistory: 128,
  maxSourceEpisodes: 128,
  maxSourceTickets: 128,
  maxHumanDecisions: 128,
  maxActiveLessons: 4096,
  maxRebuildBatch: 256,
});

const identifier = (title, maxLength = 128) => Type.String({
  title,
  minLength: 1,
  maxLength,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$",
});
const boundedText = (title, maxLength = 4096) => Type.String({ title, minLength: 1, maxLength });
const digest = Type.String({ title: "Lowercase SHA-256 digest", pattern: "^[a-f0-9]{64}$" });
const revision = Type.String({ title: "Immutable Git revision", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" });
const timestamp = Type.String({ title: "Canonical UTC RFC 3339 timestamp", format: "date-time" });
const state = Type.Union(LESSON_LIFECYCLE_STATES.map((value) => Type.Literal(value)));
const behaviorKind = Type.Union(LESSON_BEHAVIOR_KINDS.map((value) => Type.Literal(value)));
const riskLevel = Type.Union(LESSON_RISK_LEVELS.map((value) => Type.Literal(value)));
const evidenceKind = Type.Union(LESSON_EVIDENCE_KINDS.map((value) => Type.Literal(value)));

const ConditionSchema = Type.Object({
  field: identifier("Applicability field", 128),
  operator: Type.Union([
    Type.Literal("equals"),
    Type.Literal("not_equals"),
    Type.Literal("contains"),
    Type.Literal("matches"),
    Type.Literal("exists"),
    Type.Literal("not_exists"),
  ]),
  value: Type.Optional(boundedText("Applicability value", 1024)),
  values: Type.Optional(Type.Array(boundedText("Applicability value", 1024), { minItems: 1, maxItems: 64, uniqueItems: true })),
  description: Type.Optional(boundedText("Applicability condition description", 1024)),
}, { additionalProperties: false });

const EvidenceCitationSchema = Type.Object({
  id: identifier("Evidence citation identity"),
  kind: evidenceKind,
  episodeId: identifier("Source episode identity"),
  eventId: identifier("Source event identity"),
  ticketId: identifier("Source ticket identity"),
  ticketSystem: Type.Optional(identifier("Source ticket system", 64)),
  digest: Type.Optional(digest),
  citation: Type.Optional(boundedText("Evidence citation", 2048)),
  note: Type.Optional(boundedText("Evidence note", 2048)),
}, { additionalProperties: false });

const AnnotationSchema = Type.Object({
  id: identifier("Annotation identity"),
  authorId: identifier("Human annotator identity"),
  body: boundedText("Annotation body", 4096),
  createdAt: timestamp,
  decision: Type.Optional(Type.Union([Type.Literal("support"), Type.Literal("challenge"), Type.Literal("context")])),
}, { additionalProperties: false });

const HumanDecisionSchema = Type.Object({
  id: identifier("Human decision identity"),
  authorId: identifier("Human decision-maker identity"),
  decision: Type.Union([Type.Literal("approve"), Type.Literal("reject"), Type.Literal("revise"), Type.Literal("evaluate")]),
  decidedAt: timestamp,
  episodeId: Type.Optional(identifier("Decision episode identity")),
  eventId: Type.Optional(identifier("Decision event identity")),
  ticketId: Type.Optional(identifier("Decision ticket identity")),
  rationale: Type.Optional(boundedText("Decision rationale", 4096)),
}, { additionalProperties: false });

const RiskSchema = Type.Object({
  level: riskLevel,
  rationale: boundedText("Risk rationale", 4096),
  harmClass: Type.Optional(identifier("Harm class", 128)),
}, { additionalProperties: false });

const CatastrophicSafetyExceptionSchema = Type.Object({
  kind: Type.Literal("catastrophic_safety"),
  policyVersion: Type.Literal(LESSON_V1_SCHEMA_VERSION),
  episodeId: identifier("Catastrophic safety episode identity"),
  eventId: identifier("Catastrophic safety event identity"),
  ticketId: identifier("Catastrophic safety ticket identity"),
  reason: boundedText("Catastrophic safety reason", 4096),
  approvedBy: identifier("Emergency policy approver identity"),
  humanDecisionId: Type.Optional(identifier("Emergency human decision identity")),
  scope: Type.Object({ kind: Type.Literal("avoid"), target: identifier("Narrow prohibition target") }, { additionalProperties: false }),
  immediate: Type.Optional(Type.Boolean()),
  approvedAt: Type.Optional(timestamp),
  expiresAt: Type.Optional(timestamp),
}, { additionalProperties: false });

const StateHistoryEntrySchema = Type.Object({
  from: Type.Optional(state),
  to: state,
  changedAt: timestamp,
  actorId: identifier("Lifecycle actor identity"),
  reason: Type.Optional(boundedText("Lifecycle transition reason", 4096)),
  decisionId: Type.Optional(identifier("Lifecycle decision identity")),
}, { additionalProperties: false });

/**
 * Structural source for Lesson v1. Cross-field rules, content identity, and
 * lifecycle transitions are intentionally enforced by validateLessonV1 below.
 * The schema remains a pure contract and never imports the registry ledger.
 */
export const LessonV1Schema = Type.Object({
  schema: Type.Object({
    id: Type.Literal(LESSON_V1_SCHEMA_ID),
    version: Type.Literal(LESSON_V1_SCHEMA_VERSION),
  }, { additionalProperties: false }),
  id: identifier("Lesson identity"),
  version: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  state,
  applicability: Type.Object({
    conditions: Type.Array(ConditionSchema, { minItems: 1, maxItems: DEFAULT_LESSON_LIMITS.maxConditions }),
    scope: Type.Optional(Type.Object({
      projectId: Type.Optional(identifier("Applicability project identity")),
      repositoryId: Type.Optional(identifier("Applicability repository identity")),
      ticketSystem: Type.Optional(identifier("Applicability ticket system", 64)),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
  behavior: Type.Object({
    kind: behaviorKind,
    description: boundedText("Lesson behavior", 4096),
    action: Type.Optional(boundedText("Lesson action", 4096)),
    target: Type.Optional(identifier("Lesson target", 128)),
    testPlan: Type.Optional(boundedText("Lesson test plan", 4096)),
  }, { additionalProperties: false }),
  evidence: Type.Array(EvidenceCitationSchema, { minItems: 1, maxItems: DEFAULT_LESSON_LIMITS.maxEvidence }),
  annotations: Type.Array(AnnotationSchema, { maxItems: DEFAULT_LESSON_LIMITS.maxAnnotations }),
  counterevidence: Type.Array(EvidenceCitationSchema, { maxItems: DEFAULT_LESSON_LIMITS.maxCounterevidence }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  risk: RiskSchema,
  provenance: Type.Object({
    sourceEpisodes: Type.Array(identifier("Provenance source episode"), { minItems: 1, maxItems: DEFAULT_LESSON_LIMITS.maxSourceEpisodes, uniqueItems: true }),
    sourceTickets: Type.Array(identifier("Provenance source ticket"), { minItems: 1, maxItems: DEFAULT_LESSON_LIMITS.maxSourceTickets, uniqueItems: true }),
    humanDecisions: Type.Array(HumanDecisionSchema, { minItems: 1, maxItems: DEFAULT_LESSON_LIMITS.maxHumanDecisions }),
    createdBy: identifier("Lesson creator identity"),
    createdAt: timestamp,
    repositoryRevision: Type.Optional(revision),
  }, { additionalProperties: false }),
  evaluator: Type.Object({
    id: identifier("Evaluator identity"),
    version: identifier("Evaluator version", 128),
    identityDigest: Type.Optional(digest),
  }, { additionalProperties: false }),
  contentDigest: digest,
  createdAt: timestamp,
  updatedAt: Type.Optional(timestamp),
  stateHistory: Type.Array(StateHistoryEntrySchema, { maxItems: DEFAULT_LESSON_LIMITS.maxHistory }),
  rejection: Type.Optional(Type.Object({ reason: boundedText("Rejection reason", 4096), rejectedAt: timestamp, rejectedBy: identifier("Rejecting actor identity") }, { additionalProperties: false })),
  retirement: Type.Optional(Type.Object({ reason: boundedText("Retirement reason", 4096), retiredAt: timestamp, retiredBy: identifier("Retiring actor identity") }, { additionalProperties: false })),
  supersedes: Type.Optional(Type.Object({ lessonId: identifier("Superseded lesson identity"), version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })),
  supersededBy: Type.Optional(Type.Object({ lessonId: identifier("Successor lesson identity"), version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })),
  evaluation: Type.Optional(Type.Object({
    identity: identifier("Evaluation identity", 128),
    evaluatedAt: timestamp,
    score: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    notes: Type.Optional(boundedText("Evaluation notes", 4096)),
  }, { additionalProperties: false })),
  catastrophicSafetyException: Type.Optional(CatastrophicSafetyExceptionSchema),
}, {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: LESSON_V1_SCHEMA_ID,
  title: "Versioned Lesson v1",
  additionalProperties: false,
});

const compiledSchema = Compile(LessonV1Schema);
const compiledExceptionSchema = Compile(CatastrophicSafetyExceptionSchema);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const revisionPattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const digestPattern = /^[a-f0-9]{64}$/;
const textEncoder = new TextEncoder();
const stateSet = new Set(LESSON_LIFECYCLE_STATES);
const behaviorSet = new Set(LESSON_BEHAVIOR_KINDS);
const issue = (code, message, path = "") => ({ code, message, path });

/** Deterministic JSON used for lesson content identity and artifact bytes. */
export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }

function withoutMutableLessonFields(lesson) {
  const copy = structuredClone(lesson);
  for (const key of ["contentDigest", "state", "stateHistory", "updatedAt", "rejection", "retirement", "supersededBy", "evaluation"]) delete copy[key];
  return copy;
}

/** Returns the immutable identity of lesson content, independent of lifecycle state. */
export function lessonContentDigest(lesson) { return sha256Hex(canonicalJson(withoutMutableLessonFields(lesson))); }

function canonicalTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function configuredLimits(limits = {}) {
  const result = { ...DEFAULT_LESSON_LIMITS, ...limits };
  for (const [key, value] of Object.entries(result)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid lesson limit ${key}`);
  return result;
}

function stringsFrom(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => typeof entry === "string" ? [entry] : entry && typeof entry === "object" ? [entry.id, entry.ticketId, entry.episodeId, entry.eventId].filter((item) => typeof item === "string") : []);
}

function evidenceIdentitySets(lesson) {
  const episodes = new Set(), tickets = new Set(), events = new Set();
  for (const citation of [...(lesson.evidence ?? []), ...(lesson.counterevidence ?? [])]) {
    if (typeof citation.episodeId === "string") episodes.add(citation.episodeId);
    if (typeof citation.ticketId === "string") tickets.add(citation.ticketId);
    if (typeof citation.eventId === "string") events.add(citation.eventId);
  }
  return { episodes, tickets, events };
}

function semanticException(exception, lesson, errors) {
  if (exception === undefined) return;
  if (!exception || typeof exception !== "object" || Array.isArray(exception)) {
    errors.push(issue("catastrophic_exception_malformed", "catastrophic safety exception metadata is malformed", "/catastrophicSafetyException"));
    return;
  }
  if (exception.kind !== "catastrophic_safety" || exception.policyVersion !== LESSON_V1_SCHEMA_VERSION) errors.push(issue("catastrophic_exception_policy_invalid", "catastrophic safety exception must name the supported policy version", "/catastrophicSafetyException/policyVersion"));
  if (lesson?.behavior?.kind !== "avoid") errors.push(issue("catastrophic_exception_behavior_invalid", "catastrophic safety exceptions may create only avoid prohibitions", "/behavior/kind"));
  if (!exception.reason || typeof exception.reason !== "string" || exception.reason.length > 4096) errors.push(issue("catastrophic_exception_reason_invalid", "catastrophic safety exception requires a bounded reason", "/catastrophicSafetyException/reason"));
  if (!exception.approvedBy || typeof exception.approvedBy !== "string" || !identifierPattern.test(exception.approvedBy)) errors.push(issue("catastrophic_exception_approval_missing", "catastrophic safety exception requires an approving human identity", "/catastrophicSafetyException/approvedBy"));
  const scopeKind = typeof exception.scope === "string" ? exception.scope : exception.scope?.kind;
  const scopeTarget = exception.scope?.target;
  if (scopeKind !== "avoid") errors.push(issue("catastrophic_exception_scope_invalid", "catastrophic safety exception scope must be a narrow avoid prohibition", "/catastrophicSafetyException/scope"));
  if (typeof scopeTarget !== "string" || scopeTarget !== lesson?.behavior?.target) errors.push(issue("catastrophic_exception_target_mismatch", "catastrophic safety exception target must exactly bind the avoided behavior target", "/catastrophicSafetyException/scope/target"));
  if ((lesson?.applicability?.conditions?.length ?? 0) > 4) errors.push(issue("catastrophic_exception_condition_limit", "catastrophic safety exceptions may bind no more than four applicability conditions", "/applicability/conditions"));
  if (exception.approvedAt !== undefined && !canonicalTimestamp(exception.approvedAt)) errors.push(issue("timestamp_not_canonical", "approvedAt must be a canonical UTC RFC 3339 timestamp", "/catastrophicSafetyException/approvedAt"));
  if (exception.expiresAt !== undefined && !canonicalTimestamp(exception.expiresAt)) errors.push(issue("timestamp_not_canonical", "expiresAt must be a canonical UTC RFC 3339 timestamp", "/catastrophicSafetyException/expiresAt"));
  const { episodes, tickets, events } = evidenceIdentitySets(lesson ?? {});
  if (!episodes.has(exception.episodeId)) errors.push(issue("catastrophic_exception_episode_unbound", "catastrophic exception episode must be cited by lesson evidence", "/catastrophicSafetyException/episodeId"));
  if (!events.has(exception.eventId)) errors.push(issue("catastrophic_exception_event_unbound", "catastrophic exception event must be cited by lesson evidence", "/catastrophicSafetyException/eventId"));
  if (!tickets.has(exception.ticketId)) errors.push(issue("catastrophic_exception_ticket_unbound", "catastrophic exception ticket must be cited by lesson evidence", "/catastrophicSafetyException/ticketId"));
}

/** Independently validates the emergency policy metadata without registry access. */
export function validateCatastrophicSafetyException(exception, lesson) {
  const errors = [...compiledExceptionSchema.Errors(exception)].map((error) => issue("schema_invalid", error.message, error.path));
  if (errors.length === 0) semanticException(exception, lesson, errors);
  return { ok: errors.length === 0, errors };
}

/**
 * Validate one immutable Lesson v1 payload. The result never contains the
 * caller's payload; error messages contain only codes and schema paths.
 */
export function validateLessonV1(lesson, options = {}) {
  const errors = [...compiledSchema.Errors(lesson)].map((error) => issue("schema_invalid", error.message, error.path));
  if (errors.length > 0) return { ok: false, errors };
  const limits = configuredLimits(options.limits);
  if (textEncoder.encode(canonicalJson(lesson)).byteLength > limits.maxLessonBytes) errors.push(issue("lesson_oversized", "canonical lesson exceeds maxLessonBytes", "/"));
  const now = options.now === undefined ? undefined : (typeof options.now === "function" ? options.now() : options.now);
  if (now !== undefined && (!Number.isFinite(now) || now < 0)) errors.push(issue("clock_invalid", "validation clock is invalid", "/"));
  if (!stateSet.has(lesson.state)) errors.push(issue("state_invalid", "unknown lesson lifecycle state", "/state"));
  if (!behaviorSet.has(lesson.behavior.kind)) errors.push(issue("behavior_invalid", "unknown lesson behavior kind", "/behavior/kind"));
  if (lesson.evidence.length < 1) errors.push(issue("evidence_required", "a lesson requires at least one evidence citation", "/evidence"));
  if (lesson.evidence.length > limits.maxEvidence) errors.push(issue("evidence_limit_exceeded", "lesson evidence exceeds its configured bound", "/evidence"));
  if (lesson.applicability.conditions.length > limits.maxConditions) errors.push(issue("condition_limit_exceeded", "lesson applicability exceeds its configured bound", "/applicability/conditions"));
  if (lesson.annotations.length > limits.maxAnnotations) errors.push(issue("annotation_limit_exceeded", "lesson annotations exceed their configured bound", "/annotations"));
  if (lesson.counterevidence.length > limits.maxCounterevidence) errors.push(issue("counterevidence_limit_exceeded", "lesson counterevidence exceeds its configured bound", "/counterevidence"));
  if (lesson.stateHistory.length > limits.maxHistory) errors.push(issue("history_limit_exceeded", "lesson lifecycle history exceeds its configured bound", "/stateHistory"));
  for (const [path, value] of [["/createdAt", lesson.createdAt], ["/provenance/createdAt", lesson.provenance.createdAt]]) if (!canonicalTimestamp(value)) errors.push(issue("timestamp_not_canonical", "timestamps must be canonical UTC RFC 3339 values", path));
  if (lesson.updatedAt !== undefined && !canonicalTimestamp(lesson.updatedAt)) errors.push(issue("timestamp_not_canonical", "updatedAt must be a canonical UTC RFC 3339 value", "/updatedAt"));
  for (const [index, annotation] of lesson.annotations.entries()) if (!canonicalTimestamp(annotation.createdAt)) errors.push(issue("timestamp_not_canonical", "annotation createdAt must be canonical", `/annotations/${index}/createdAt`));
  for (const [index, decision] of lesson.provenance.humanDecisions.entries()) if (!canonicalTimestamp(decision.decidedAt)) errors.push(issue("timestamp_not_canonical", "human decision decidedAt must be canonical", `/provenance/humanDecisions/${index}/decidedAt`));
  if (!Number.isFinite(lesson.confidence) || lesson.confidence < 0 || lesson.confidence > 1) errors.push(issue("confidence_invalid", "confidence must be between zero and one", "/confidence"));
  if (lesson.provenance.sourceEpisodes.length === 0 || lesson.provenance.sourceTickets.length === 0) errors.push(issue("provenance_missing", "lesson provenance must include source episodes and tickets", "/provenance"));
  const identities = evidenceIdentitySets(lesson);
  for (const episode of lesson.provenance.sourceEpisodes) if (!identities.episodes.has(episode)) errors.push(issue("provenance_episode_unbound", "every provenance episode must be cited by evidence", "/provenance/sourceEpisodes"));
  for (const ticket of lesson.provenance.sourceTickets) if (!identities.tickets.has(ticket)) errors.push(issue("provenance_ticket_unbound", "every provenance ticket must be cited by evidence", "/provenance/sourceTickets"));
  const computedDigest = lessonContentDigest(lesson);
  if (!digestPattern.test(lesson.contentDigest)) errors.push(issue("content_digest_invalid", "contentDigest must be a lowercase SHA-256 digest", "/contentDigest"));
  else if (lesson.contentDigest !== computedDigest) errors.push(issue("content_digest_mismatch", "contentDigest does not match immutable lesson content", "/contentDigest"));
  if (lesson.stateHistory.length > 0 && lesson.stateHistory.at(-1).to !== lesson.state) errors.push(issue("state_history_mismatch", "the last lifecycle history entry must name the current state", "/stateHistory"));
  for (let index = 0; index < lesson.stateHistory.length; index += 1) {
    const entry = lesson.stateHistory[index];
    if (!canonicalTimestamp(entry.changedAt)) errors.push(issue("timestamp_not_canonical", "state history changedAt must be canonical", `/stateHistory/${index}/changedAt`));
    if (entry.from !== undefined && !stateSet.has(entry.from)) errors.push(issue("state_history_invalid", "state history contains an unknown source state", `/stateHistory/${index}/from`));
    if (index > 0 && entry.from !== lesson.stateHistory[index - 1].to) errors.push(issue("state_history_disconnected", "state history transitions must form one chain", `/stateHistory/${index}/from`));
    if (entry.from !== undefined && !allowedTransition(entry.from, entry.to)) errors.push(issue("state_transition_invalid", "lesson lifecycle transition is not allowed", `/stateHistory/${index}`));
  }
  if (lesson.rejection && !["rejected", "superseded"].includes(lesson.state)) errors.push(issue("rejection_state_invalid", "rejection metadata is allowed only on rejected or superseded lessons", "/rejection"));
  if (lesson.retirement && lesson.state !== "retired") errors.push(issue("retirement_state_invalid", "retirement metadata is allowed only on retired lessons", "/retirement"));
  if (lesson.supersededBy && lesson.state !== "superseded") errors.push(issue("supersession_state_invalid", "supersededBy metadata is allowed only on superseded lessons", "/supersededBy"));
  semanticException(lesson.catastrophicSafetyException, lesson, errors);
  if (now !== undefined && lesson.catastrophicSafetyException?.expiresAt && Date.parse(lesson.catastrophicSafetyException.expiresAt) <= now) errors.push(issue("catastrophic_exception_expired", "catastrophic safety exception has expired", "/catastrophicSafetyException/expiresAt"));
  return { ok: errors.length === 0, errors, contentDigest: computedDigest };
}

export function assertLessonV1(lesson, options = {}) {
  const result = validateLessonV1(lesson, options);
  if (!result.ok) throw new LessonValidationError(result.errors);
  return lesson;
}

export class LessonValidationError extends Error {
  constructor(errors) {
    super(`Lesson v1 validation failed: ${errors.map((error) => error.code).join(", ")}`);
    this.name = "LessonValidationError";
    this.errors = errors.map(({ code, message, path }) => ({ code, message, path }));
  }
}

const TRANSITIONS = Object.freeze({
  proposed: Object.freeze(["evaluated", "promoted", "rejected"]),
  evaluated: Object.freeze(["promoted", "rejected", "superseded"]),
  promoted: Object.freeze(["monitored", "reverted", "retired", "superseded"]),
  monitored: Object.freeze(["reverted", "retired", "superseded"]),
  reverted: Object.freeze(["retired", "superseded"]),
  retired: Object.freeze([]),
  superseded: Object.freeze([]),
  rejected: Object.freeze([]),
});
export const LESSON_TRANSITIONS = TRANSITIONS;
export function allowedTransition(from, to) { return from === to || Boolean(TRANSITIONS[from]?.includes(to)); }
export function validateLessonTransition(from, to) {
  const errors = [];
  if (!stateSet.has(from) || !stateSet.has(to)) errors.push(issue("state_invalid", "unknown lesson lifecycle state"));
  else if (from !== to && !allowedTransition(from, to)) errors.push(issue("state_transition_invalid", "lesson lifecycle transition is not allowed"));
  return { ok: errors.length === 0, errors };
}

/** Fill only deterministic lifecycle defaults; no authority or evidence is invented. */
export function normalizeLessonV1(input, { now = new Date().toISOString() } = {}) {
  const lesson = structuredClone(input);
  if (lesson.annotations === undefined) lesson.annotations = [];
  if (lesson.counterevidence === undefined) lesson.counterevidence = [];
  if (lesson.stateHistory === undefined) lesson.stateHistory = [];
  if (lesson.contentDigest === undefined && lesson.id && lesson.version) lesson.contentDigest = lessonContentDigest(lesson);
  if (lesson.createdAt === undefined) lesson.createdAt = now;
  if (lesson.provenance && lesson.provenance.createdAt === undefined) lesson.provenance.createdAt = lesson.createdAt;
  if (lesson.updatedAt === undefined) lesson.updatedAt = lesson.createdAt;
  if (lesson.evaluator?.identityDigest === undefined && lesson.evaluator?.id && lesson.evaluator?.version) lesson.evaluator.identityDigest = sha256Hex(canonicalJson(lesson.evaluator));
  if (lesson.contentDigest !== undefined) lesson.contentDigest = lessonContentDigest(lesson);
  return lesson;
}

export function isLessonLifecycleState(value) { return stateSet.has(value); }
export function isLessonBehaviorKind(value) { return behaviorSet.has(value); }
export function isLessonRevision(value) { return typeof value === "string" && revisionPattern.test(value); }
export const validateLesson = validateLessonV1;
export const assertLesson = assertLessonV1;
export function isLessonIdentifier(value) { return typeof value === "string" && identifierPattern.test(value); }
