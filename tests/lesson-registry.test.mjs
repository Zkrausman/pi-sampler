import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { LessonRegistry, LessonRegistryError, LessonRegistryPromotionError } from "../ledgers/lesson-registry.mjs";
import { EpisodeEvolutionLedger } from "../ledgers/episode-evolution-ledger.mjs";
import { catastrophicLesson, lesson, singleTicketLesson } from "./helpers/lesson-conformance.mjs";

const fixedNow = Date.parse("2026-08-18T00:00:00.000Z");
async function withRegistry(body, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "lesson-registry-"));
  let registry;
  try {
    registry = await LessonRegistry.open({ root, now: () => fixedNow, ...options });
    await body(registry, root);
  } finally {
    await registry?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function proposeAndEvaluate(registry, candidate = lesson()) {
  await registry.propose(candidate);
  await registry.evaluate(candidate.id, { identity: "evaluation-1", score: 0.92, notes: "independent evaluation" });
  return registry.get(candidate.id);
}

test("LessonRegistry persists proposals and rebuilds version/state history", async () => withRegistry(async (registry, root) => {
  const candidate = lesson();
  const proposed = await registry.propose(candidate);
  assert.equal(proposed.status, "committed");
  assert.equal(registry.get(candidate.id).state, "proposed");
  await registry.evaluate(candidate.id, { identity: "evaluation-1", score: 0.9 });
  assert.equal(registry.get(candidate.id).state, "evaluated");
  assert.equal(registry.get(candidate.id).stateHistory.at(-1).to, "evaluated");
  await registry.close();
  const reopened = await LessonRegistry.open({ root, now: () => fixedNow });
  try {
    const restored = reopened.get(candidate.id);
    assert.equal(restored.state, "evaluated");
    assert.equal(restored.contentDigest, candidate.contentDigest);
    assert.equal(restored.stateHistory.length, 1);
  } finally { await reopened.close(); }
}));

test("normal promotion requires multiple tickets and preserves a clean cache on rejection", async () => withRegistry(async (registry) => {
  const candidate = singleTicketLesson();
  await registry.propose(candidate);
  await registry.evaluate(candidate.id, { identity: "evaluation-single" });
  await assert.rejects(registry.promote(candidate.id), (error) => error instanceof LessonRegistryPromotionError && error.code === "evidence_ticket_breadth_insufficient");
  assert.equal(registry.get(candidate.id).state, "evaluated");
}));

test("catastrophic safety exception permits only the narrow one-ticket avoid path", async () => withRegistry(async (registry) => {
  const candidate = catastrophicLesson();
  await registry.propose(candidate);
  const result = await registry.promote(candidate.id);
  assert.equal(result.lesson.state, "promoted");
}));

test("promotion detects contradictory overlapping behavior rather than choosing a winner", async () => withRegistry(async (registry) => {
  const first = lesson({ id: "lesson-repeat", behavior: { kind: "repeat", description: "repeat the safe operation", action: "retry" } });
  await proposeAndEvaluate(registry, first);
  await registry.promote(first.id);
  const second = lesson({ id: "lesson-avoid", behavior: { kind: "avoid", description: "avoid the same operation", action: "stop" } });
  await proposeAndEvaluate(registry, second);
  await assert.rejects(registry.promote(second.id), (error) => error.code === "conflict_detected");
  assert.equal(registry.get(second.id).state, "evaluated");
}));

test("catastrophic exceptions do not bypass stale repository evidence", async () => withRegistry(async (registry) => {
  const candidate = catastrophicLesson({ id: "lesson-stale-catastrophic" });
  await registry.propose(candidate);
  await assert.rejects(registry.promote(candidate.id), (error) => error.code === "evidence_stale");
}, { currentRepositoryRevision: "b".repeat(40) }));

test("conflict and overlap detector failures reject promotion without leaking ledger packets", async () => withRegistry(async (registry) => {
  const candidate = lesson({ id: "lesson-detector-failure" });
  await proposeAndEvaluate(registry, candidate);
  const original = registry.detectConflicts;
  registry.detectConflicts = async () => { throw new Error("RAW_LEDGER_PACKET_SHOULD_NOT_ESCAPE"); };
  await assert.rejects(registry.promote(candidate.id), (error) => {
    assert.equal(error.code, "conflict_detection_failed");
    assert.doesNotMatch(error.message, /RAW_LEDGER_PACKET/);
    assert.doesNotMatch(JSON.stringify(error.details), /RAW_LEDGER_PACKET/);
    return true;
  });
  registry.detectConflicts = original;
  assert.equal(registry.get(candidate.id).state, "evaluated");
}));

test("supersession and retirement preserve historical states", async () => withRegistry(async (registry) => {
  const candidate = lesson({ id: "lesson-retire" });
  await proposeAndEvaluate(registry, candidate);
  await registry.reject(candidate.id, { reason: "insufficient confidence", actorId: "human-reviewer" });
  assert.equal(registry.get(candidate.id).state, "rejected");
  await assert.rejects(registry.promote(candidate.id), (error) => error.code === "state_transition_invalid");
}));

test("bounded streams refuse an incomplete listRecords fallback", async () => {
  const fakeLedger = {
    async listRecords() { return { records: [], truncated: true }; },
  };
  const registry = new LessonRegistry({ ledger: fakeLedger, now: () => fixedNow });
  await assert.rejects(registry.rebuild({ batchSize: 1 }), (error) => error instanceof LessonRegistryError && error.code === "ledger_stream_truncated");
});

test("registry only depends on the ledger write direction", async () => {
  const root = await mkdtemp(join(tmpdir(), "lesson-registry-dependency-"));
  const ledger = await EpisodeEvolutionLedger.open({ root });
  const registry = new LessonRegistry({ ledger, now: () => fixedNow });
  try {
    assert.equal(registry.ledger, ledger);
    assert.equal(typeof registry.ledger.appendEpisodeWithArtifactBatch, "function");
    assert.equal(typeof registry.ledger.appendEvolution, "function");
  } finally { await registry.close(); await rm(root, { recursive: true, force: true }); }
});
