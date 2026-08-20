import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

export const LESSON_V1_SCHEMA_ID = "https://pi-sampler.dev/contracts/lesson/v1";
export const LESSON_V1_SCHEMA_VERSION = "1.0.0";
export const LESSON_STATES = Object.freeze(["proposed", "evaluated", "promoted", "monitored", "reverted", "retired", "superseded", "rejected"]);
export const LESSON_TRANSITIONS = Object.freeze({
  proposed: Object.freeze(["evaluated", "rejected"]),
  evaluated: Object.freeze(["promoted", "rejected"]),
  promoted: Object.freeze(["monitored", "reverted", "retired", "superseded"]),
  monitored: Object.freeze(["reverted", "retired", "superseded"]),
  reverted: Object.freeze(["retired", "superseded"]),
  retired: Object.freeze([]), superseded: Object.freeze([]), rejected: Object.freeze([]),
});

const identifier = (title) => Type.String({ title, minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$" });
const text = (title, maximum = 4096) => Type.String({ title, minLength: 1, maxLength: maximum });
const timestamp = Type.String({ format: "date-time" });
const humanDecision = Type.Object({ id: identifier("Decision identity"), decidedBy: identifier("Human decision-maker"), decidedAt: timestamp, rationale: text("Decision rationale") }, { additionalProperties: false });
const evidence = Type.Object({
  episodeId: identifier("Episode identity"), eventId: identifier("Evidence event identity"),
  ticket: Type.Object({ system: identifier("Work-item system"), id: identifier("Work-item identity") }, { additionalProperties: false }),
  citation: text("Exact evidence citation"), observedAt: timestamp,
}, { additionalProperties: false });
const evaluator = Type.Object({ id: identifier("Evaluator identity"), kind: Type.Union([Type.Literal("human"), Type.Literal("connected_authority")]), evaluatedAt: timestamp }, { additionalProperties: false });
const parent = Type.Object({ lessonId: identifier("Parent lesson identity"), version: Type.Integer({ minimum: 1 }), digest: Type.String({ pattern: "^[0-9a-f]{64}$" }) }, { additionalProperties: false });

export const LessonV1Schema = Type.Object({
  schema: Type.Object({ id: Type.Literal(LESSON_V1_SCHEMA_ID), version: Type.Literal(LESSON_V1_SCHEMA_VERSION) }, { additionalProperties: false }),
  id: identifier("Stable lesson identity"), version: Type.Integer({ minimum: 1 }),
  state: Type.Union(LESSON_STATES.map((state) => Type.Literal(state))),
  applicability: Type.Object({ scope: identifier("Applicability scope"), conditions: Type.Array(text("Applicability condition", 1024), { minItems: 1, maxItems: 64, uniqueItems: true }), expiresAt: Type.Optional(timestamp) }, { additionalProperties: false }),
  behavior: Type.Object({ kind: Type.Union([Type.Literal("repeat"), Type.Literal("avoid"), Type.Literal("test")]), instruction: text("Inspectable candidate behavior", 8192) }, { additionalProperties: false }),
  evidence: Type.Array(evidence, { minItems: 1, maxItems: 256 }),
  annotations: Type.Array(text("Annotation", 2048), { maxItems: 128 }),
  counterevidence: Type.Array(evidence, { maxItems: 256 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("catastrophic")]),
  decisions: Type.Array(humanDecision, { minItems: 1, maxItems: 64 }),
  provenance: Type.Object({ createdAt: timestamp, createdBy: identifier("Creator identity"), parent: Type.Optional(parent) }, { additionalProperties: false }),
  evaluator: Type.Optional(evaluator),
  catastrophicSafety: Type.Optional(Type.Object({ policyId: identifier("Emergency policy identity"), authorizedBy: identifier("Human authorizer"), authorizedAt: timestamp, rationale: text("Emergency rationale"), narrowProhibition: Type.Literal(true) }, { additionalProperties: false })),
  conflictResolution: Type.Optional(Type.Object({ strategy: Type.Union([Type.Literal("supersede"), Type.Literal("reject")]), lessonIds: Type.Array(identifier("Resolved lesson identity"), { minItems: 1, uniqueItems: true }), decidedBy: identifier("Human decision-maker"), rationale: text("Conflict resolution rationale") }, { additionalProperties: false })),
}, { $schema: "https://json-schema.org/draft/2020-12/schema", $id: LESSON_V1_SCHEMA_ID, title: "Lesson v1", additionalProperties: false });

const compiled = Compile(LessonV1Schema);
const stable = (value) => value === undefined ? "null" : value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
export const lessonDigestV1 = (lesson) => createHash("sha256").update(stable(lesson)).digest("hex");
const issue = (code, message, path = "") => ({ code, message, path });
const canonicalTimestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

export function validateLessonV1(lesson) {
  const errors = [...compiled.Errors(lesson)].map((error) => issue("schema_invalid", error.message, error.path));
  if (errors.length) return { ok: false, errors };
  for (const [path, value] of [["/provenance/createdAt", lesson.provenance.createdAt], ...lesson.evidence.map((item, index) => [`/evidence/${index}/observedAt`, item.observedAt]), ...lesson.counterevidence.map((item, index) => [`/counterevidence/${index}/observedAt`, item.observedAt]), ...lesson.decisions.flatMap((item, index) => [[`/decisions/${index}/decidedAt`, item.decidedAt]]), ...(lesson.evaluator ? [["/evaluator/evaluatedAt", lesson.evaluator.evaluatedAt]] : []), ...(lesson.catastrophicSafety ? [["/catastrophicSafety/authorizedAt", lesson.catastrophicSafety.authorizedAt]] : []), ...(lesson.applicability.expiresAt ? [["/applicability/expiresAt", lesson.applicability.expiresAt]] : [])]) if (!canonicalTimestamp(value)) errors.push(issue("timestamp_not_canonical", "timestamps must be canonical UTC RFC 3339 values with milliseconds", path));
  if (lesson.version === 1 && lesson.provenance.parent !== undefined) errors.push(issue("parent_for_initial_version", "version 1 must not declare a parent", "/provenance/parent"));
  if (lesson.version > 1 && (!lesson.provenance.parent || lesson.provenance.parent.lessonId !== lesson.id || lesson.provenance.parent.version !== lesson.version - 1)) errors.push(issue("parent_version_invalid", "later versions must bind the immediately preceding version of the same lesson", "/provenance/parent"));
  if (lesson.state !== "proposed" && !lesson.evaluator) errors.push(issue("evaluator_required", "non-proposed lessons require an evaluator identity", "/evaluator"));
  if (lesson.catastrophicSafety && (lesson.behavior.kind !== "avoid" || lesson.risk !== "catastrophic")) errors.push(issue("catastrophic_policy_too_broad", "catastrophic safety policy is limited to catastrophic avoid lessons", "/catastrophicSafety"));
  const citations = new Set();
  for (const [index, item] of lesson.evidence.entries()) { const key = `${item.episodeId}\0${item.eventId}`; if (citations.has(key)) errors.push(issue("duplicate_evidence", "evidence citations must be unique", `/evidence/${index}`)); citations.add(key); }
  return { ok: errors.length === 0, errors };
}

export function validateLessonTransitionV1(previous, next) {
  const result = validateLessonV1(next), errors = [...result.errors];
  if (!previous || validateLessonV1(previous).ok !== true) errors.push(issue("previous_invalid", "previous lesson version must be valid", "/previous"));
  else {
    if (previous.id !== next.id || next.version !== previous.version + 1) errors.push(issue("lineage_invalid", "transition must create the next version of the same lesson", "/version"));
    if (!LESSON_TRANSITIONS[previous.state].includes(next.state)) errors.push(issue("transition_invalid", `${previous.state} cannot transition to ${next.state}`, "/state"));
    if (next.provenance.parent?.lessonId !== previous.id || next.provenance.parent?.version !== previous.version || next.provenance.parent?.digest !== lessonDigestV1(previous)) errors.push(issue("parent_lineage_invalid", "transition provenance must bind the exact previous version", "/provenance/parent"));
  }
  return { ok: errors.length === 0, errors };
}

export class LessonValidationError extends Error {
  constructor(errors) { super(`Lesson v1 validation failed: ${errors.map(({ code }) => code).join(", ")}`); this.name = "LessonValidationError"; this.errors = errors; }
}
export function assertLessonV1(lesson) { const result = validateLessonV1(lesson); if (!result.ok) throw new LessonValidationError(result.errors); return lesson; }
export function assertLessonTransitionV1(previous, next) { const result = validateLessonTransitionV1(previous, next); if (!result.ok) throw new LessonValidationError(result.errors); return next; }
