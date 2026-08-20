import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LessonV1Schema, LessonValidationError, assertLessonTransitionV1, validateLessonV1, validateLessonTransitionV1 } from "../contracts/lesson-v1.mjs";
import { emergencyLesson, lesson, nextLesson } from "./helpers/lesson-conformance.mjs";

test("Lesson v1 validates a cited proposal and exports its sole schema to stdout", () => {
  assert.equal(validateLessonV1(lesson()).ok, true);
  const result = spawnSync(process.execPath, ["scripts/export-lesson-v1-schema.mjs"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0); assert.equal(result.stderr, ""); assert.deepEqual(JSON.parse(result.stdout), LessonV1Schema);
});

test("Lesson v1 rejects zero evidence, duplicate evidence, and malformed emergency policy", () => {
  assert.equal(validateLessonV1(lesson({ evidence: [] })).ok, false);
  const duplicate = lesson(); duplicate.evidence.push({ ...duplicate.evidence[0] });
  assert.ok(validateLessonV1(duplicate).errors.some(({ code }) => code === "duplicate_evidence"));
  const broad = emergencyLesson({ behavior: { kind: "repeat", instruction: "Repeat an unsafe emergency behavior." } });
  assert.ok(validateLessonV1(broad).errors.some(({ code }) => code === "catastrophic_policy_too_broad"));
});

test("version lineage and lifecycle transitions are fail closed", () => {
  const proposed = lesson(), evaluated = nextLesson(proposed, "evaluated");
  assert.equal(validateLessonTransitionV1(proposed, evaluated).ok, true);
  const invalid = nextLesson(proposed, "promoted");
  assert.ok(validateLessonTransitionV1(proposed, invalid).errors.some(({ code }) => code === "transition_invalid"));
  assert.throws(() => assertLessonTransitionV1(proposed, invalid), LessonValidationError);
  const detached = nextLesson(evaluated, "promoted"); detached.provenance.parent = { lessonId: evaluated.id, version: 1, digest: "0".repeat(64) };
  assert.ok(validateLessonTransitionV1(evaluated, detached).errors.some(({ code }) => ["parent_version_invalid", "parent_lineage_invalid"].includes(code)));
});

test("non-proposed versions preserve evaluator identity and canonical provenance", () => {
  const proposed = lesson(), evaluated = nextLesson(proposed, "evaluated", { evaluator: undefined }); delete evaluated.evaluator;
  assert.ok(validateLessonV1(evaluated).errors.some(({ code }) => code === "evaluator_required"));
  const timestamp = lesson({ provenance: { createdAt: "2026-08-19T00:03:00Z" } });
  assert.ok(validateLessonV1(timestamp).errors.some(({ code }) => code === "timestamp_not_canonical"));
});
