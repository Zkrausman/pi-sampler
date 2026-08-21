import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

export const ANNOTATION_V1_SCHEMA_ID = "https://pi-sampler.dev/contracts/annotation/v1";
export const ANNOTATION_V1_SCHEMA_VERSION = "1.0.0";
export const ANNOTATION_SCHEMA_ID = ANNOTATION_V1_SCHEMA_ID;
export const ANNOTATION_SCHEMA_VERSION = ANNOTATION_V1_SCHEMA_VERSION;

export const ANNOTATION_TARGET_KINDS = Object.freeze([
  "event",
  "range",
  "decision",
  "artifact",
  "outcome",
  "retrospective_claim",
  "lesson",
  "experiment",
]);
export const ANNOTATION_TYPES = Object.freeze([
  "helped",
  "hurt",
  "incorrect",
  "important-context",
  "caused-rework",
  "repeat",
  "avoid",
  "value-assessment",
  "freeform",
]);
export const ANNOTATION_SENSITIVITY = Object.freeze(["public", "internal", "confidential", "restricted"]);
export const ANNOTATION_EVIDENCE_CLASSES = Object.freeze(["human_annotation"]);
export const ANNOTATION_TARGET_TYPES = ANNOTATION_TARGET_KINDS;
export const ANNOTATION_KINDS = ANNOTATION_TYPES;
export const ANNOTATION_SENSITIVITIES = ANNOTATION_SENSITIVITY;
export const DEFAULT_ANNOTATION_LIMITS = Object.freeze({
  maxAnnotationBytes: 64 * 1024,
  maxRationaleBytes: 16 * 1024,
  maxContentBytes: 32 * 1024,
  maxAnnotations: 100_000,
  maxRevisionsPerAnnotation: 4096,
  maxQueryRecords: 1000,
  maxQueryBytes: 4 * 1024 * 1024,
  maxExportBytes: 64 * 1024 * 1024,
  maxRebuildBatch: 256,
  maxMigrationBatch: 256,
});

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const digestPattern = /^[a-f0-9]{64}$/;
const identifier = (title, maxLength = 128) => Type.String({ title, minLength: 1, maxLength, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$" });
const digest = Type.String({ title: "Lowercase SHA-256 digest", pattern: "^[a-f0-9]{64}$" });
const timestamp = Type.String({ title: "Canonical UTC RFC 3339 timestamp", format: "date-time" });
const boundedText = (title, maxLength) => Type.String({ title, minLength: 1, maxLength });
const targetKind = Type.Union(ANNOTATION_TARGET_KINDS.map((value) => Type.Literal(value)));
const annotationType = Type.Union(ANNOTATION_TYPES.map((value) => Type.Literal(value)));
const sensitivity = Type.Union(ANNOTATION_SENSITIVITY.map((value) => Type.Literal(value)));

export const AnnotationAuthorSchema = Type.Object({
  id: identifier("Human annotation author identity"),
  kind: Type.Literal("human"),
}, { additionalProperties: false });

export const AnnotationTargetSchema = Type.Object({
  kind: targetKind,
  id: identifier("Annotation target identity"),
  start: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  end: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
}, { additionalProperties: false });

export const AnnotationRevisionSchema = Type.Object({
  id: identifier("Annotation revision identity"),
  number: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  parentId: Type.Optional(Type.Union([identifier("Parent annotation revision identity"), Type.Null()])),
  parentDigest: Type.Optional(Type.Union([digest, Type.Null()])),
}, { additionalProperties: false });

/**
 * Structural source for Annotation v1. The evidence class is intentionally a
 * literal rather than a broad evidence union: this contract can retain only a
 * human annotation and therefore cannot mint observed external evidence.
 * Cross-field ancestry, digest, timestamp, and tombstone rules are enforced by
 * validateAnnotationV1 below.
 */
export const AnnotationV1Schema = Type.Object({
  schema: Type.Object({
    id: Type.Literal(ANNOTATION_V1_SCHEMA_ID),
    version: Type.Literal(ANNOTATION_V1_SCHEMA_VERSION),
  }, { additionalProperties: false }),
  id: identifier("Annotation identity"),
  type: annotationType,
  target: AnnotationTargetSchema,
  author: AnnotationAuthorSchema,
  createdAt: timestamp,
  sensitivity,
  rationale: boundedText("Annotation rationale", DEFAULT_ANNOTATION_LIMITS.maxRationaleBytes),
  evidenceClass: Type.Literal("human_annotation"),
  revision: AnnotationRevisionSchema,
  contentDigest: digest,
  content: Type.Optional(boundedText("Annotation content", DEFAULT_ANNOTATION_LIMITS.maxContentBytes)),
  value: Type.Optional(Type.Union([
    boundedText("Annotation scalar value", 4096),
    Type.Number(),
    Type.Boolean(),
  ])),
  tombstone: Type.Optional(Type.Boolean()),
  tombstoneReason: Type.Optional(boundedText("Tombstone reason", DEFAULT_ANNOTATION_LIMITS.maxRationaleBytes)),
}, {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: ANNOTATION_V1_SCHEMA_ID,
  title: "Portable human Annotation v1",
  additionalProperties: false,
});

export const AnnotationSchema = AnnotationV1Schema;
export const AnnotationV1 = AnnotationV1Schema;

const compiledSchema = Compile(AnnotationV1Schema);
const targetKindSet = new Set(ANNOTATION_TARGET_KINDS);
const annotationTypeSet = new Set(ANNOTATION_TYPES);
const sensitivitySet = new Set(ANNOTATION_SENSITIVITY);
const encoder = new TextEncoder();
const issue = (code, message, path = "") => ({ code, message, path });
const clone = (value) => structuredClone(value);

/** Deterministic JSON used for content-addressed annotation revisions. */
export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }
export function canonicalTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}
export function isAnnotationIdentifier(value) { return typeof value === "string" && identifierPattern.test(value); }
export function isAnnotationDigest(value) { return typeof value === "string" && digestPattern.test(value); }
export function isAnnotationTargetKind(value) { return targetKindSet.has(value); }
export function isAnnotationType(value) { return annotationTypeSet.has(value); }
export function isAnnotationSensitivity(value) { return sensitivitySet.has(value); }

function withoutDigest(annotation) {
  const copy = clone(annotation);
  delete copy.contentDigest;
  return copy;
}

/** Returns the immutable digest for one revision, excluding only contentDigest itself. */
export function annotationContentDigest(annotation) {
  const canonical = normalizeAnnotationV1(annotation, { fillDefaults: false });
  return sha256Hex(canonicalJson(withoutDigest(canonical)));
}
export const annotationDigest = annotationContentDigest;

function aliasTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return target;
  const result = { ...target };
  if (result.kind === "retrospective-claim" || result.kind === "retrospectiveClaim") result.kind = "retrospective_claim";
  if (result.type !== undefined && result.kind === undefined) result.kind = result.type;
  if (result.identity !== undefined && result.id === undefined) result.id = result.identity;
  if (result.range && typeof result.range === "object" && !Array.isArray(result.range)) {
    if (result.start === undefined) result.start = result.range.start;
    if (result.end === undefined) result.end = result.range.end;
    delete result.range;
  }
  delete result.type;
  delete result.identity;
  return result;
}

function aliasRevision(input, { revisionId } = {}) {
  const source = input.revisionAncestry ?? input.revision ?? {};
  const result = typeof source === "number" ? { number: source } : source && typeof source === "object" && !Array.isArray(source) ? { ...source } : {};
  if (result.sequence !== undefined && result.number === undefined) result.number = result.sequence;
  if (result.version !== undefined && result.number === undefined) result.number = result.version;
  if (input.revisionNumber !== undefined && result.number === undefined) result.number = input.revisionNumber;
  if (input.parentRevisionId !== undefined && result.parentId === undefined) result.parentId = input.parentRevisionId;
  if (input.parentRevisionDigest !== undefined && result.parentDigest === undefined) result.parentDigest = input.parentRevisionDigest;
  if (input.parentId !== undefined && result.parentId === undefined) result.parentId = input.parentId;
  if (input.parentDigest !== undefined && result.parentDigest === undefined) result.parentDigest = input.parentDigest;
  if (result.parent && typeof result.parent === "object" && !Array.isArray(result.parent)) {
    if (result.parentId === undefined) result.parentId = result.parent.id;
    if (result.parentDigest === undefined) result.parentDigest = result.parent.digest;
    delete result.parent;
  }
  if (result.parentId === null) delete result.parentId;
  if (result.parentDigest === null) delete result.parentDigest;
  if (input.revisionId !== undefined && result.id === undefined) result.id = input.revisionId;
  if (revisionId !== undefined && result.id === undefined) result.id = revisionId;
  delete result.sequence;
  delete result.version;
  return result;
}

function aliasAuthor(author, input) {
  const value = author ?? input.authorId;
  if (typeof value === "string") return { id: value, kind: "human" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return { ...value, kind: value.kind ?? value.type ?? "human" };
}

/**
 * Normalize the small set of pre-v1 spellings accepted for migration. Unknown
 * properties are retained so the strict schema still rejects scope creep.
 */
export function normalizeAnnotationV1(input, { now = new Date().toISOString(), revisionId, fillDefaults = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const result = clone(input);
  if (result.metadata && typeof result.metadata === "object" && !Array.isArray(result.metadata)) {
    for (const key of ["author", "authorId", "createdAt", "timestamp", "sensitivity", "rationale", "reason", "evidenceClass", "target", "targetIdentity"]) if (result[key] === undefined && result.metadata[key] !== undefined) result[key] = result.metadata[key];
    delete result.metadata;
  }
  if (result.target === undefined && result.targetIdentity !== undefined) result.target = typeof result.targetIdentity === "object" ? result.targetIdentity : { kind: result.targetKind ?? "event", id: result.targetIdentity };
  if (result.annotationType !== undefined && result.type === undefined) result.type = result.annotationType;
  if (result.kind !== undefined && result.type === undefined && result.target === undefined) result.type = result.kind;
  if (typeof result.type === "string") result.type = { "important_context": "important-context", "caused_rework": "caused-rework", "value_assessment": "value-assessment", "free_form": "freeform" }[result.type] ?? result.type;
  if (result.target !== undefined) result.target = aliasTarget(result.target);
  if (result.timestamp !== undefined && result.createdAt === undefined) result.createdAt = result.timestamp;
  if (result.author !== undefined || result.authorId !== undefined) {
    result.author = aliasAuthor(result.author, result);
    if (result.author && typeof result.author === "object" && result.author.type !== undefined && result.author.kind === undefined) result.author.kind = result.author.type;
    if (result.author && typeof result.author === "object") delete result.author.type;
  }
  if (result.evidence !== undefined && result.evidenceClass === undefined && typeof result.evidence === "string") result.evidenceClass = result.evidence;
  if (result.evidence && typeof result.evidence === "object" && !Array.isArray(result.evidence) && result.evidenceClass === undefined) result.evidenceClass = result.evidence.class;
  if (result.reason !== undefined && result.rationale === undefined) result.rationale = result.reason;
  if (result.body !== undefined && result.content === undefined) result.content = result.body;
  if (result.revisionAncestry !== undefined || result.revision !== undefined || result.revisionId !== undefined || result.revisionNumber !== undefined || result.parentId !== undefined || result.parentDigest !== undefined || result.parentRevisionId !== undefined || result.parentRevisionDigest !== undefined || revisionId !== undefined) {
    result.revision = aliasRevision(result, { revisionId });
  }
  if (result.tombstone && typeof result.tombstone === "object" && !Array.isArray(result.tombstone)) {
    const tombstone = result.tombstone;
    result.tombstone = true;
    if (result.tombstoneReason === undefined) result.tombstoneReason = tombstone.reason ?? tombstone.rationale;
    if (result.createdAt === undefined) result.createdAt = tombstone.deletedAt;
    if (result.author === undefined && tombstone.deletedBy !== undefined) result.author = aliasAuthor(tombstone.deletedBy, result);
  }
  if (result.tombstone === true && result.createdAt === undefined && result.deletedAt !== undefined) result.createdAt = result.deletedAt;
  if (result.tombstone === true && result.author === undefined && result.deletedBy !== undefined) result.author = aliasAuthor(result.deletedBy, result);
  if (result.deleted === true && result.tombstone === undefined) result.tombstone = true;
  delete result.annotationType;
  delete result.timestamp;
  delete result.authorId;
  delete result.evidence;
  delete result.reason;
  delete result.body;
  delete result.revisionAncestry;
  delete result.revisionId;
  delete result.revisionNumber;
  delete result.parentId;
  delete result.parentDigest;
  delete result.parentRevisionId;
  delete result.parentRevisionDigest;
  delete result.deleted;
  delete result.deletedAt;
  delete result.deletedBy;
  delete result.targetIdentity;
  delete result.targetKind;
  if (fillDefaults) {
    result.schema ??= { id: ANNOTATION_V1_SCHEMA_ID, version: ANNOTATION_V1_SCHEMA_VERSION };
    if (result.createdAt === undefined) result.createdAt = now;
    result.evidenceClass ??= "human_annotation";
    result.revision ??= {};
    result.revision.number ??= 1;
    if (result.revision.id === undefined && result.id !== undefined) result.revision.id = revisionId ?? `annotation-revision-${sha256Hex(`${result.id}\u0000${result.revision.number}`).slice(0, 48)}`;
    if (result.rationale === undefined && result.tombstone === true && result.tombstoneReason !== undefined) result.rationale = result.tombstoneReason;
    if (result.contentDigest === undefined && result.id !== undefined && result.revision?.id !== undefined) result.contentDigest = annotationContentDigest(result);
  }
  return result;
}

/** Convert an unversioned legacy payload to the current structural spelling. */
export function migrateAnnotationV1(input, options = {}) {
  const result = normalizeAnnotationV1(input, { ...options, fillDefaults: true });
  if (result && typeof result === "object" && !Array.isArray(result)) {
    result.schema = { id: ANNOTATION_V1_SCHEMA_ID, version: ANNOTATION_V1_SCHEMA_VERSION };
    result.contentDigest = annotationContentDigest(result);
  }
  return result;
}

function configuredLimits(limits = {}) {
  const value = { ...DEFAULT_ANNOTATION_LIMITS, ...limits };
  for (const [key, limit] of Object.entries(value)) if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError(`invalid annotation limit ${key}`);
  return Object.freeze(value);
}

/**
 * Stateless, fail-closed validation. The caller's object is never mutated and
 * no authority verifier or ledger state is consulted.
 */
export function validateAnnotationV1(input, { limits, now } = {}) {
  const candidate = normalizeAnnotationV1(input, { fillDefaults: false });
  const errors = [...compiledSchema.Errors(candidate)].map((error) => issue("schema_invalid", error.message, error.path));
  if (errors.length > 0) return { ok: false, errors };
  const configured = configuredLimits(limits);
  if (encoder.encode(canonicalJson(candidate)).byteLength > configured.maxAnnotationBytes) errors.push(issue("annotation_oversized", "canonical annotation exceeds maxAnnotationBytes", "/"));
  if (!canonicalTimestamp(candidate.createdAt)) errors.push(issue("timestamp_not_canonical", "createdAt must be a canonical UTC RFC 3339 value", "/createdAt"));
  if (now !== undefined) {
    const clock = typeof now === "function" ? now() : now;
    if (!Number.isFinite(clock)) errors.push(issue("clock_invalid", "validation clock is invalid", "/"));
    else if (Date.parse(candidate.createdAt) > clock) errors.push(issue("timestamp_future", "createdAt is later than the validation clock", "/createdAt"));
  }
  if (!targetKindSet.has(candidate.target.kind)) errors.push(issue("target_kind_invalid", "annotation target kind is not supported", "/target/kind"));
  if (candidate.target.kind === "range") {
    if (candidate.target.start === undefined || candidate.target.end === undefined) errors.push(issue("target_range_missing", "range targets require start and end bounds", "/target"));
    else if (candidate.target.end < candidate.target.start) errors.push(issue("target_range_invalid", "range target end must not precede start", "/target/end"));
  } else if (candidate.target.start !== undefined || candidate.target.end !== undefined) {
    errors.push(issue("target_range_kind_invalid", "only range targets may carry start and end bounds", "/target"));
  }
  if (candidate.author.kind !== "human") errors.push(issue("author_kind_invalid", "annotations require a human author", "/author/kind"));
  if (candidate.evidenceClass !== "human_annotation") errors.push(issue("evidence_class_invalid", "annotations may carry only human_annotation evidence", "/evidenceClass"));
  if (candidate.revision.parentId === undefined && candidate.revision.parentDigest !== undefined) errors.push(issue("revision_parent_incomplete", "revision parentId and parentDigest must be supplied together", "/revision"));
  if (candidate.revision.parentId !== undefined && candidate.revision.parentDigest === undefined) errors.push(issue("revision_parent_incomplete", "revision parentId and parentDigest must be supplied together", "/revision"));
  if (candidate.revision.parentId === candidate.revision.id) errors.push(issue("revision_cycle", "a revision cannot be its own parent", "/revision/parentId"));
  if (candidate.tombstone === true && !candidate.tombstoneReason) errors.push(issue("tombstone_reason_required", "a tombstone requires a bounded reason", "/tombstoneReason"));
  if (candidate.tombstone !== true && candidate.tombstoneReason !== undefined) errors.push(issue("tombstone_reason_invalid", "tombstoneReason is allowed only on a tombstone", "/tombstoneReason"));
  const rationaleBytes = encoder.encode(candidate.rationale).byteLength;
  if (rationaleBytes > configured.maxRationaleBytes) errors.push(issue("rationale_oversized", "annotation rationale exceeds maxRationaleBytes in UTF-8 bytes", "/rationale"));
  if (candidate.tombstoneReason !== undefined) {
    const tombstoneReasonBytes = encoder.encode(candidate.tombstoneReason).byteLength;
    if (tombstoneReasonBytes > configured.maxRationaleBytes) errors.push(issue("tombstone_reason_oversized", "tombstone reason exceeds maxRationaleBytes in UTF-8 bytes", "/tombstoneReason"));
  }
  if (candidate.content !== undefined && encoder.encode(candidate.content).byteLength > configured.maxContentBytes) errors.push(issue("content_oversized", "annotation content exceeds maxContentBytes", "/content"));
  if (candidate.contentDigest !== annotationContentDigest(candidate)) errors.push(issue("content_digest_mismatch", "contentDigest does not match immutable annotation content", "/contentDigest"));
  return { ok: errors.length === 0, errors, contentDigest: annotationContentDigest(candidate), annotation: clone(candidate) };
}

export function assertAnnotationV1(annotation, options = {}) {
  const result = validateAnnotationV1(annotation, options);
  if (!result.ok) throw new AnnotationValidationError(result.errors);
  return annotation;
}

export class AnnotationValidationError extends Error {
  constructor(errors) {
    super(`Annotation v1 validation failed: ${errors.map((error) => error.code).join(", ")}`);
    this.name = "AnnotationValidationError";
    this.errors = errors.map(({ code, message, path }) => ({ code, message, path }));
  }
}

export function isAnnotationTombstone(annotation) { return annotation?.tombstone === true; }
export function createAnnotationV1(input, options = {}) {
  const candidate = normalizeAnnotationV1(input, { ...options, fillDefaults: true });
  candidate.contentDigest = annotationContentDigest(candidate);
  assertAnnotationV1(candidate, options);
  return candidate;
}

export const normalizeAnnotation = normalizeAnnotationV1;
export const migrateAnnotation = migrateAnnotationV1;
export const validateAnnotation = validateAnnotationV1;
export const assertAnnotation = assertAnnotationV1;
export default AnnotationV1Schema;
