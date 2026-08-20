import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  LESSON_LIFECYCLE_STATES,
  LESSON_V1_SCHEMA_ID,
  LESSON_V1_SCHEMA_VERSION,
  lessonContentDigest,
  validateCatastrophicSafetyException,
  validateLessonTransition,
  validateLessonV1,
} from "../contracts/lesson-v1.mjs";
import { catastrophicLesson, lesson, malformedCatastrophicLesson, zeroEvidenceLesson } from "./helpers/lesson-conformance.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const codes = (result) => result.errors.map(({ code }) => code);

test("Lesson v1 accepts a cited, versioned lesson with human provenance", () => {
  const candidate = lesson();
  const result = validateLessonV1(candidate, { now: Date.parse("2026-08-18T00:00:00.000Z") });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(candidate.schema.id, LESSON_V1_SCHEMA_ID);
  assert.equal(candidate.schema.version, LESSON_V1_SCHEMA_VERSION);
  assert.equal(candidate.contentDigest, lessonContentDigest(candidate));
});

test("Lesson v1 rejects zero evidence, unbound provenance, and mutable content identities", () => {
  const empty = validateLessonV1(zeroEvidenceLesson());
  assert.equal(empty.ok, false);
  assert.ok(codes(empty).includes("schema_invalid") || codes(empty).includes("evidence_required"));

  const unbound = lesson({ provenance: { sourceEpisodes: ["episode-not-cited"] } });
  const unboundResult = validateLessonV1(unbound);
  assert.equal(unboundResult.ok, false);
  assert.ok(codes(unboundResult).includes("provenance_episode_unbound"));

  const changed = lesson({ behavior: { description: "changed without rebinding" } });
  changed.contentDigest = lesson().contentDigest;
  const changedResult = validateLessonV1(changed);
  assert.equal(changedResult.ok, false);
  assert.ok(codes(changedResult).includes("content_digest_mismatch"));
});

test("Lesson v1 lifecycle transitions are directed and terminal states cannot be silently reopened", () => {
  assert.deepEqual(LESSON_LIFECYCLE_STATES, ["proposed", "evaluated", "promoted", "monitored", "reverted", "retired", "superseded", "rejected"]);
  assert.equal(validateLessonTransition("proposed", "evaluated").ok, true);
  assert.equal(validateLessonTransition("proposed", "promoted").ok, true);
  assert.equal(validateLessonTransition("retired", "promoted").ok, false);
  assert.equal(validateLessonTransition("rejected", "proposed").ok, false);
});

test("catastrophic safety metadata is narrow, bound to evidence, and fail-closed", () => {
  const candidate = catastrophicLesson();
  assert.equal(validateCatastrophicSafetyException(candidate.catastrophicSafetyException, candidate).ok, true);
  const malformed = malformedCatastrophicLesson();
  const result = validateLessonV1(malformed);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("schema_invalid") || codes(result).includes("catastrophic_exception_policy_invalid"));
  const unbound = catastrophicLesson({ catastrophicSafetyException: { ...candidate.catastrophicSafetyException, eventId: "event-not-cited" } });
  assert.equal(validateLessonV1(unbound).ok, false);
  const broad = catastrophicLesson({ catastrophicSafetyException: { ...candidate.catastrophicSafetyException, scope: "avoid" } });
  assert.equal(validateLessonV1(broad).ok, false);
  const mismatchedTarget = catastrophicLesson({ catastrophicSafetyException: { ...candidate.catastrophicSafetyException, scope: { kind: "avoid", target: "different-target" } } });
  assert.equal(validateLessonV1(mismatchedTarget).ok, false);
});

test("Lesson schema exporter emits only stdout and never creates the prohibited checked-in artifact", async () => {
  const schemaPath = join(root, "contracts", "lesson-v1.schema.json");
  await assert.rejects(access(schemaPath));
  const command = spawnSync(process.execPath, ["scripts/export-lesson-v1-schema.mjs", "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(command.status, 0, command.stderr);
  const schema = JSON.parse(command.stdout);
  assert.equal(schema.$id, LESSON_V1_SCHEMA_ID);
  assert.equal(schema.title, "Versioned Lesson v1");
  await assert.rejects(access(schemaPath));
  assert.ok((await readdir(join(root, "contracts"))).every((name) => name !== "lesson-v1.schema.json"));
});
