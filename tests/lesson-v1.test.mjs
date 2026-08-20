import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LESSON_V1_SCHEMA_ID,
  LESSON_V1_SCHEMA_VERSION,
  validateLessonTransition,
  validateLessonV1,
} from "../contracts/lesson-v1.mjs";
import { lessonFixture, zeroEvidenceLesson } from "./helpers/lesson-conformance.mjs";

const codes = (result) => result.errors.map((error) => error.code);

test("Lesson v1 accepts canonical, cited versioned lessons", () => {
  const lesson = lessonFixture();
  assert.equal(lesson.schema.id, LESSON_V1_SCHEMA_ID);
  assert.equal(lesson.schema.version, LESSON_V1_SCHEMA_VERSION);
  assert.equal(validateLessonV1(lesson).ok, true);
});

test("Lesson v1 rejects missing evidence, duplicate citations, and mutable provenance", () => {
  assert.ok(codes(validateLessonV1(zeroEvidenceLesson())).includes("evidence_required"));
  const duplicate = lessonFixture({ evidence: [lessonFixture().evidence[0], lessonFixture().evidence[0]] });
  assert.ok(codes(validateLessonV1(duplicate)).includes("duplicate_evidence_citation"));
  const selfSource = lessonFixture({ provenance: { ...lessonFixture().provenance, sourceLessonIds: ["lesson-safe-shell"] } });
  assert.ok(codes(validateLessonV1(selfSource)).includes("provenance_self_reference"));
});

test("Lesson v1 lifecycle allows only directed immutable transitions", () => {
  const proposed = lessonFixture();
  const evaluated = { ...structuredClone(proposed), lesson: { ...proposed.lesson, revision: 2 }, state: "evaluated" };
  assert.equal(validateLessonTransition(proposed, evaluated).ok, true);
  const jump = { ...structuredClone(proposed), lesson: { ...proposed.lesson, revision: 2 }, state: "promoted" };
  assert.ok(codes(validateLessonTransition(proposed, jump)).includes("lifecycle_transition_invalid"));
  const leaked = { ...structuredClone(evaluated), behavior: { ...evaluated.behavior, guidance: "changed after proposal" } };
  assert.ok(codes(validateLessonTransition(proposed, leaked)).includes("immutable_field_changed"));
});

test("lesson schema export writes only stdout and leaves a controlled directory untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lesson-schema-export-"));
  try {
    const command = spawnSync(process.execPath, ["scripts/export-lesson-v1-schema.mjs"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    assert.equal(command.status, 0, command.stderr);
    const schema = JSON.parse(command.stdout);
    assert.equal(schema.$id, LESSON_V1_SCHEMA_ID);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(lstat(join(directory, "lesson-v1.schema.json")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
