import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, lessonDigest } from "../contracts/lesson-v1.mjs";
import { LessonRegistry, LessonRegistryError } from "../ledgers/lesson-registry.mjs";
import { catastrophicAvoidLesson, lessonFixture, malformedBypassLesson, singleTicketLesson, zeroEvidenceLesson } from "./helpers/lesson-conformance.mjs";

async function withRegistry(body) {
  const root = await mkdtemp(join(tmpdir(), "lesson-registry-")); let registry;
  try { registry = await LessonRegistry.open({ root }); await body(registry, root); }
  finally { await registry?.close(); await rm(root, { recursive: true, force: true }); }
}
const rejects = (code) => (error) => error instanceof LessonRegistryError && error.code === code;

test("registry persists lifecycle snapshots and rebuilds active state", async () => withRegistry(async (registry, root) => {
  await registry.propose(lessonFixture());
  await registry.evaluate("lesson-safe-shell");
  const promoted = await registry.promote("lesson-safe-shell");
  assert.equal(promoted.lesson.state, "promoted");
  await registry.close();
  const reopened = await LessonRegistry.open({ root });
  try {
    const rebuilt = await reopened.get("lesson-safe-shell");
    assert.equal(rebuilt.state, "promoted");
    assert.equal(rebuilt.lesson.revision, 3);
  } finally { await reopened.close(); }
}));

test("zero evidence and one-ticket feature lessons fail closed while catastrophic avoid is narrow", async () => withRegistry(async (registry) => {
  await assert.rejects(registry.propose(zeroEvidenceLesson()), (error) => error.code === "lesson_validation_failed");
  await registry.propose(singleTicketLesson());
  await registry.evaluate("lesson-safe-shell");
  await assert.rejects(registry.promote("lesson-safe-shell"), rejects("promotion_evidence_breadth_insufficient"));

  const emergency = catastrophicAvoidLesson(); emergency.lesson = { id: "lesson-emergency-avoid", revision: 1 };
  await registry.propose(emergency); await registry.evaluate(emergency.lesson.id);
  assert.equal((await registry.promote(emergency.lesson.id)).lesson.state, "promoted");

  const malformed = malformedBypassLesson(); malformed.lesson = { id: "lesson-malformed-bypass", revision: 1 };
  await assert.rejects(registry.propose(malformed), (error) => error.code === "lesson_validation_failed");
}));

test("conflicting overlap requires explicit resolution and does not mutate active state", async () => withRegistry(async (registry) => {
  await registry.propose(lessonFixture()); await registry.evaluate("lesson-safe-shell"); await registry.promote("lesson-safe-shell");
  const contradictory = lessonFixture({
    lesson: { id: "lesson-require-shell", revision: 1 },
    behavior: { action: "require", subject: "unsafe-shell-interpolation", guidance: "Require shell interpolation." },
    evidence: [
      { ticket: { system: "linear", id: "AIDEV-201" }, eventId: "event-201", digest: "d".repeat(64) },
      { ticket: { system: "linear", id: "AIDEV-202" }, eventId: "event-202", digest: "e".repeat(64) },
    ],
  });
  await registry.propose(contradictory); await registry.evaluate(contradictory.lesson.id);
  await assert.rejects(registry.promote(contradictory.lesson.id), rejects("promotion_conflict_detected"));
  assert.equal((await registry.get(contradictory.lesson.id)).state, "evaluated");
  await registry.supersede("lesson-safe-shell");
  assert.equal((await registry.promote(contradictory.lesson.id)).lesson.state, "promoted");
}));

test("promotion fails closed if its bounded streamed conflict scan throws", async () => {
  let broken = false;
  const ledger = {
    async appendEpisodeWithArtifactBatch() { return { status: "committed" }; },
    async readArtifact() { throw new Error("not reached"); },
    async *streamRecords() { if (broken) throw new Error("injected scan failure"); },
  };
  const registry = await LessonRegistry.open({ ledger });
  try {
    await registry.propose(lessonFixture()); await registry.evaluate("lesson-safe-shell");
    broken = true;
    await assert.rejects(registry.promote("lesson-safe-shell"), rejects("promotion_conflict_detection_failed"));
    assert.equal((await registry.get("lesson-safe-shell")).state, "evaluated");
  } finally { await registry.close(); }
});

test("rebuild rejects a persisted promotion that bypassed evidence breadth", async () => {
  const proposed = singleTicketLesson();
  const evaluated = { ...structuredClone(proposed), lesson: { ...proposed.lesson, revision: 2 }, state: "evaluated" };
  const promoted = { ...structuredClone(evaluated), lesson: { ...evaluated.lesson, revision: 3 }, state: "promoted" };
  const entries = [proposed, evaluated, promoted].map((lesson) => {
    const digest = lessonDigest(lesson), bytes = new TextEncoder().encode(canonicalJson(lesson));
    return { lesson, bytes, entry: { record: { event: { kind: "lesson", id: `lesson-event-${lessonDigest({ domain: "lesson-event", value: `${lesson.lesson.id}\u0000${lesson.lesson.revision}` })}` } }, artifacts: [{ identity: "lesson-v1", evidenceClass: "caller_claim", digest }] } };
  });
  const bytesByDigest = new Map(entries.map(({ entry, bytes }) => [entry.artifacts[0].digest, bytes]));
  const ledger = {
    async *streamRecords() { yield entries.map(({ entry }) => entry); },
    async readArtifact(reference) { return bytesByDigest.get(reference.digest); },
  };
  await assert.rejects(LessonRegistry.open({ ledger }), rejects("persisted_lesson_promotion_invalid"));
});

test("rebuild consumes bounded stream batches without retaining the batch", async () => {
  const batches = [];
  for (let index = 0; index < 50; index += 1) batches.push([]);
  const ledger = { async *streamRecords({ batchSize }) { assert.equal(batchSize, 2); for (const batch of batches) yield batch; } };
  const registry = await LessonRegistry.open({ ledger, limits: { maxRebuildBatch: 2 } });
  try { assert.deepEqual(await registry.list(), { lessons: [], truncated: false }); }
  finally { await registry.close(); }
});

test("rebuild and admissions share one serialization queue", async () => {
  let pause = false, reached, release;
  const reachedPromise = new Promise((resolve) => { reached = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const ledger = {
    async appendEpisodeWithArtifactBatch() { return { status: "committed" }; },
    async *streamRecords() { if (pause) { reached(); await releasePromise; } yield []; },
  };
  const registry = await LessonRegistry.open({ ledger });
  try {
    pause = true;
    const rebuilding = registry.rebuild(); await reachedPromise;
    const proposing = registry.propose(lessonFixture());
    release(); await rebuilding; await proposing;
    assert.equal((await registry.get("lesson-safe-shell")).state, "proposed");
  } finally { await registry.close(); }
});

test("an endless empty streamed result fails closed at the batch bound", async () => {
  const ledger = { async *streamRecords() { while (true) yield []; } };
  await assert.rejects(LessonRegistry.open({ ledger, limits: { maxScanRecords: 2, maxScanBatches: 2 } }), rejects("ledger_scan_truncated"));
});
