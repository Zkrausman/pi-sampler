import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EpisodeEvolutionLedger } from "../ledgers/episode-evolution-ledger.mjs";
import { LessonRegistry, LessonRegistryError } from "../ledgers/lesson-registry.mjs";
import { emergencyLesson, episodeRecord, lesson, nextLesson } from "./helpers/lesson-conformance.mjs";

async function withRegistry(options, body) {
  const root = await mkdtemp(join(tmpdir(), "lesson-registry-")); let ledger;
  try { ledger = await EpisodeEvolutionLedger.open({ root }); const registry = new LessonRegistry({ ledger, ...options }); await body(registry, ledger, root); }
  finally { await ledger?.close(); await rm(root, { recursive: true, force: true }); }
}

async function evaluate(registry, proposed) { await registry.propose(proposed, episodeRecord(proposed)); const evaluated = nextLesson(proposed, "evaluated"); await registry.evaluate(evaluated, episodeRecord(evaluated)); return evaluated; }

test("lesson versions persist in atomic ledger batches and rebuild with history", async () => {
  const root = await mkdtemp(join(tmpdir(), "lesson-registry-reopen-")); let ledger;
  try {
    ledger = await EpisodeEvolutionLedger.open({ root }); let registry = new LessonRegistry({ ledger });
    const proposed = lesson(), evaluated = await evaluate(registry, proposed), promoted = nextLesson(evaluated, "promoted");
    assert.equal((await registry.promote(promoted, episodeRecord(promoted))).status, "committed");
    await ledger.close(); ledger = await EpisodeEvolutionLedger.open({ root }); registry = new LessonRegistry({ ledger });
    assert.deepEqual(await registry.rebuild(), { lessons: 1, versions: 3 });
    assert.equal((await registry.get(proposed.id)).state, "promoted"); assert.equal((await registry.get(proposed.id, 1)).state, "proposed");
  } finally { await ledger?.close(); await rm(root, { recursive: true, force: true }); }
});

test("one-ticket promotions fail closed while a narrow human-governed catastrophic avoid lesson is permitted", async () => withRegistry({}, async (registry) => {
  const proposed = lesson({ evidence: [lesson().evidence[0]] }), evaluated = await evaluate(registry, proposed), promoted = nextLesson(evaluated, "promoted");
  await assert.rejects(registry.promote(promoted, episodeRecord(promoted)), (error) => error.code === "evidence_breadth_insufficient");
  assert.equal((await registry.get(proposed.id)).state, "evaluated");

  const emergency = emergencyLesson(), emergencyEvaluated = await evaluate(registry, emergency), emergencyPromoted = nextLesson(emergencyEvaluated, "promoted");
  assert.equal((await registry.promote(emergencyPromoted, episodeRecord(emergencyPromoted))).status, "committed");
}));

test("monitoring cannot bypass active-rule promotion policy", async () => withRegistry({}, async (registry) => {
  const proposed = lesson({ id: "lesson-monitor-policy" }), evaluated = await evaluate(registry, proposed), promoted = nextLesson(evaluated, "promoted"); await registry.promote(promoted, episodeRecord(promoted));
  const monitored = nextLesson(promoted, "monitored", { behavior: { kind: "avoid", instruction: "Replace the promoted rule." }, evidence: [promoted.evidence[0]] });
  await assert.rejects(registry.monitor(monitored, episodeRecord(monitored)), (error) => error.code === "evidence_breadth_insufficient");
  assert.equal((await registry.get(proposed.id)).state, "promoted"); assert.equal(registry.transition, undefined);
}));

test("detector errors stop promotion without raw error leakage or active-cache mutation", async () => withRegistry({ conflictDetector: () => { const error = new Error("raw private ledger packet"); error.code = "ETIMEDOUT"; throw error; } }, async (registry) => {
  const first = lesson({ id: "lesson-first", behavior: { kind: "avoid", instruction: "Do not skip the release gate." } }); await evaluate(registry, first);
  const second = lesson({ id: "lesson-second", behavior: { kind: "repeat", instruction: "Skip the release gate." } }), evaluated = await evaluate(registry, second), promoted = nextLesson(evaluated, "promoted");
  await assert.rejects(registry.promote(promoted, episodeRecord(promoted)), (error) => error.code === "conflict_detection_failed" && error.details.causeCode === "ETIMEDOUT" && !error.message.includes("private"));
  assert.equal((await registry.get(second.id)).state, "evaluated");
}));

test("detector timeouts fail promotion closed", async () => withRegistry({ detectorTimeoutMs: 5, conflictDetector: () => new Promise(() => {}) }, async (registry) => {
  const first = lesson({ id: "lesson-timeout-first" }); await evaluate(registry, first);
  const second = lesson({ id: "lesson-timeout-second" }), evaluated = await evaluate(registry, second), promoted = nextLesson(evaluated, "promoted");
  await assert.rejects(registry.promote(promoted, episodeRecord(promoted)), (error) => error.code === "conflict_detection_failed" && error.details.causeCode === "detector_timeout");
  assert.equal((await registry.get(second.id)).state, "evaluated");
}));

test("conflicting lessons require an explicit human disposition and overlaps remain visible", async () => withRegistry({}, async (registry) => {
  const avoid = lesson({ id: "lesson-avoid", behavior: { kind: "avoid", instruction: "Do not skip the release gate." } }); await evaluate(registry, avoid);
  const repeat = lesson({ id: "lesson-repeat", behavior: { kind: "repeat", instruction: "Skip the release gate." } }), evaluated = await evaluate(registry, repeat);
  const blocked = nextLesson(evaluated, "promoted");
  await assert.rejects(registry.promote(blocked, episodeRecord(blocked)), (error) => error.code === "unresolved_conflict");
  const resolved = { ...blocked, conflictResolution: { strategy: "supersede", lessonIds: [avoid.id], decidedBy: "maintainer-1", rationale: "The prohibition is authoritative for this scope." } };
  const result = await registry.promote(resolved, episodeRecord(resolved));
  assert.deepEqual(result.conflicts, [{ id: avoid.id, version: 2 }]); assert.deepEqual(result.overlaps, [{ id: avoid.id, version: 2 }]);
}));

test("failed durable admission rolls back cache state", async () => {
  const durable = [];
  const ledger = { listRecords: async () => ({ records: durable, truncated: false }), readArtifact: async () => { throw new Error("unused"); }, appendEpisodeWithArtifactBatch: async () => { const error = new Error("disk failed"); error.code = "EIO"; throw error; } };
  const registry = new LessonRegistry({ ledger }); const proposed = lesson();
  await assert.rejects(registry.propose(proposed, episodeRecord(proposed)), (error) => error.code === "ledger_admission_failed" && error.details.causeCode === "EIO" && !error.message.includes("disk failed")); assert.equal(await registry.get(proposed.id), undefined);
});

test("rebuild and admission share one mutation queue", async () => {
  let releaseScan, scanStarted, appendCalls = 0;
  const started = new Promise((resolve) => { scanStarted = resolve; }), release = new Promise((resolve) => { releaseScan = resolve; });
  const ledger = { appendEpisodeWithArtifactBatch: async () => { appendCalls += 1; return { status: "committed" }; }, readArtifact: async () => new Uint8Array(), async *streamRecords() { scanStarted(); await release; } };
  const registry = new LessonRegistry({ ledger }), rebuilding = registry.rebuild(); await started;
  const proposed = lesson({ id: "lesson-concurrent-rebuild" }), admitting = registry.propose(proposed, episodeRecord(proposed));
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(appendCalls, 0);
  releaseScan(); await rebuilding; await admitting;
  assert.equal(appendCalls, 1); assert.equal((await registry.get(proposed.id)).id, proposed.id);
});

test("rebuild rejects lesson artifacts attached to mismatched Ticket Episode records", async () => withRegistry({}, async (registry, ledger) => {
  const proposed = lesson({ id: "lesson-rebuild-binding" }); await registry.propose(proposed, episodeRecord(proposed));
  const page = await ledger.listRecords(); const mismatched = structuredClone(page.records); mismatched[0].record.episode.id = "lesson:someone-else";
  const adapter = { appendEpisodeWithArtifactBatch: (...args) => ledger.appendEpisodeWithArtifactBatch(...args), readArtifact: (...args) => ledger.readArtifact(...args), async *streamRecords() { yield mismatched; } };
  await assert.rejects(new LessonRegistry({ ledger: adapter }).rebuild(), (error) => error.code === "lesson_record_mismatch");
}));

test("streamed rebuild discards large unrelated batches and enforces its hard bound", async () => {
  const count = 25_000;
  const ledger = { appendEpisodeWithArtifactBatch: async () => ({ status: "committed" }), readArtifact: async () => new Uint8Array(), async *streamRecords({ batchSize }) { let batch = []; for (let index = 0; index < count; index += 1) { batch.push({ record: { event: { kind: "usage" } }, artifacts: [] }); if (batch.length === batchSize) { yield batch; batch = []; } } if (batch.length) yield batch; } };
  const registry = new LessonRegistry({ ledger, batchSize: 37, maxScanRecords: count }); assert.deepEqual(await registry.rebuild(), { lessons: 0, versions: 0 });
  const bounded = new LessonRegistry({ ledger, batchSize: 37, maxScanRecords: count - 1 }); await assert.rejects(bounded.rebuild(), (error) => error.code === "scan_limit_exceeded");
});

test("staleness, rule accumulation, retirement, rejection, and supersession preserve history", async () => withRegistry({}, async (registry) => {
  const stale = lesson({ id: "lesson-stale", applicability: { expiresAt: "2026-08-19T02:00:00.000Z" } }), evaluated = await evaluate(registry, stale), promoted = nextLesson(evaluated, "promoted"); await registry.promote(promoted, episodeRecord(promoted));
  assert.equal((await registry.listStale({ asOf: "2026-08-20T00:00:00.000Z" })).length, 1); assert.equal((await registry.ruleAccumulation({ scope: "delivery", maximum: 1 })).count, 1);
  const retired = nextLesson(promoted, "retired"); await registry.retire(retired, episodeRecord(retired)); assert.equal((await registry.get(stale.id, 3)).state, "promoted"); assert.equal((await registry.get(stale.id)).state, "retired");

  const rejectedProposal = lesson({ id: "lesson-rejected" }), rejectedEvaluation = await evaluate(registry, rejectedProposal), rejected = nextLesson(rejectedEvaluation, "rejected"); await registry.reject(rejected, episodeRecord(rejected)); assert.equal((await registry.get(rejected.id)).state, "rejected");
}));

test("EpisodeEvolutionLedger remains independent of lesson validation", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../ledgers/episode-evolution-ledger.mjs", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /lesson-v1|lesson-registry/);
  assert.ok(LessonRegistryError);
});
