import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

export const LESSON_V1_SCHEMA_ID = "https://pi-sampler.dev/contracts/lesson/v1";
export const LESSON_V1_SCHEMA_VERSION = "1.0.0";
export const LESSON_STATES = Object.freeze(["proposed", "evaluated", "promoted", "monitored", "reverted", "retired", "superseded", "rejected"]);

const identifier = (title, maxLength = 128) => Type.String({ title, minLength: 1, maxLength, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$" });
const timestamp = Type.String({ title: "Canonical UTC RFC 3339 timestamp", format: "date-time" });
const digest = Type.String({ title: "Lowercase SHA-256 digest", pattern: "^[a-f0-9]{64}$" });
const state = Type.Union(LESSON_STATES.map((value) => Type.Literal(value)));

/**
 * Structural source for Lesson v1. The semantic validator below is
 * authoritative for canonical time, non-empty evidence, provenance immutability,
 * and lifecycle transition checks.
 */
export const LessonV1Schema = Type.Object({
  schema: Type.Object({ id: Type.Literal(LESSON_V1_SCHEMA_ID), version: Type.Literal(LESSON_V1_SCHEMA_VERSION) }, { additionalProperties: false }),
  lesson: Type.Object({ id: identifier("Lesson identity"), revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
  state,
  applicability: Type.Object({
    repositories: Type.Array(identifier("Repository identity"), { minItems: 1, maxItems: 64, uniqueItems: true }),
    taskKinds: Type.Array(identifier("Task kind", 64), { minItems: 1, maxItems: 64, uniqueItems: true }),
  }, { additionalProperties: false }),
  behavior: Type.Object({
    action: Type.Union([Type.Literal("avoid"), Type.Literal("prefer"), Type.Literal("require")]),
    subject: identifier("Behavior subject", 128),
    guidance: Type.String({ minLength: 1, maxLength: 4096 }),
  }, { additionalProperties: false }),
  evidence: Type.Array(Type.Object({
    ticket: Type.Object({ system: identifier("Ticket system", 64), id: identifier("Ticket identity") }, { additionalProperties: false }),
    eventId: identifier("Evidence event identity"),
    digest,
  }, { additionalProperties: false }), { maxItems: 256 }),
  provenance: Type.Object({
    createdAt: timestamp,
    immutableRevision: digest,
    sourceLessonIds: Type.Array(identifier("Source lesson identity"), { maxItems: 64, uniqueItems: true }),
  }, { additionalProperties: false }),
  catastrophicSafetyException: Type.Optional(Type.Object({
    category: Type.Literal("catastrophic-safety"),
    severity: Type.Literal("catastrophic"),
    rationale: Type.String({ minLength: 1, maxLength: 2048 }),
  }, { additionalProperties: false })),
}, { $schema: "https://json-schema.org/draft/2020-12/schema", $id: LESSON_V1_SCHEMA_ID, title: "Versioned lesson v1", additionalProperties: false });

const compiled = Compile(LessonV1Schema);
const transitions = new Map([
  ["proposed", new Set(["evaluated", "rejected"])],
  ["evaluated", new Set(["promoted", "rejected", "retired"])],
  ["promoted", new Set(["monitored", "reverted", "superseded"])],
  ["monitored", new Set(["reverted", "retired", "superseded"])],
  ["reverted", new Set()], ["retired", new Set()], ["superseded", new Set()], ["rejected", new Set()],
]);
const issue = (code, message, path = "") => ({ code, message, path });

export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
export function lessonDigest(lesson) { return createHash("sha256").update(canonicalJson(lesson)).digest("hex"); }
export function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
export function lessonTicketKeys(lesson) { return new Set((lesson?.evidence ?? []).map((entry) => `${entry.ticket.system}\u0000${entry.ticket.id}`)); }
export function isCatastrophicSafetyException(lesson) {
  const exception = lesson?.catastrophicSafetyException;
  return lesson?.behavior?.action === "avoid" && exception?.category === "catastrophic-safety" && exception?.severity === "catastrophic" && typeof exception.rationale === "string" && exception.rationale.trim().length > 0;
}

/** Validates one standalone Lesson v1 document without any ledger dependency. */
export function validateLessonV1(lesson) {
  const errors = [...compiled.Errors(lesson)].map((error) => issue("schema_invalid", error.message, error.path));
  if (errors.length) return { ok: false, errors };
  if (!canonicalTimestamp(lesson.provenance.createdAt)) errors.push(issue("timestamp_not_canonical", "provenance.createdAt must be canonical UTC RFC 3339 with milliseconds", "/provenance/createdAt"));
  if (lesson.evidence.length === 0) errors.push(issue("evidence_required", "a lesson requires at least one immutable evidence citation", "/evidence"));
  const citations = new Set();
  for (let index = 0; index < lesson.evidence.length; index += 1) {
    const evidence = lesson.evidence[index], key = `${evidence.ticket.system}\u0000${evidence.ticket.id}\u0000${evidence.eventId}\u0000${evidence.digest}`;
    if (citations.has(key)) errors.push(issue("duplicate_evidence_citation", "evidence citations must be unique", `/evidence/${index}`));
    citations.add(key);
  }
  if (lesson.provenance.sourceLessonIds.includes(lesson.lesson.id)) errors.push(issue("provenance_self_reference", "a lesson cannot cite itself as a source lesson", "/provenance/sourceLessonIds"));
  return { ok: errors.length === 0, errors };
}

/** Ensures a state change preserves immutable lesson content and follows the DAG. */
export function validateLessonTransition(previous, next) {
  const errors = [];
  const prior = validateLessonV1(previous), candidate = validateLessonV1(next);
  if (!prior.ok) errors.push(...prior.errors.map((error) => ({ ...error, path: `/previous${error.path}` })));
  if (!candidate.ok) errors.push(...candidate.errors.map((error) => ({ ...error, path: `/next${error.path}` })));
  if (errors.length) return { ok: false, errors };
  if (previous.lesson.id !== next.lesson.id) errors.push(issue("lesson_identity_changed", "transitions cannot change lesson identity", "/next/lesson/id"));
  if (next.lesson.revision !== previous.lesson.revision + 1) errors.push(issue("revision_not_incremented", "transitions must increment revision by exactly one", "/next/lesson/revision"));
  if (!transitions.get(previous.state)?.has(next.state)) errors.push(issue("lifecycle_transition_invalid", "requested lifecycle transition is not allowed", "/next/state"));
  for (const field of ["schema", "applicability", "behavior", "evidence", "provenance", "catastrophicSafetyException"]) {
    if (canonicalJson(previous[field]) !== canonicalJson(next[field])) errors.push(issue("immutable_field_changed", `${field} is immutable after proposal`, `/next/${field}`));
  }
  return { ok: errors.length === 0, errors };
}

export class LessonValidationError extends Error {
  constructor(errors) { super(`Lesson v1 validation failed: ${errors.map((error) => error.code).join(", ")}`); this.name = "LessonValidationError"; this.code = "lesson_validation_failed"; this.errors = errors; }
}
