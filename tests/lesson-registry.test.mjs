import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { canonicalJson, sha256Hex } from "../contracts/lesson-v1.mjs";
import { LessonRegistry, LessonRegistryConflictError, LessonRegistryError, LessonRegistryPromotionError } from "../ledgers/lesson-registry.mjs";
import { EpisodeEvolutionLedger, verifyLessonAdmission } from "../ledgers/episode-evolution-ledger.mjs";
import { catastrophicLesson, lesson, singleTicketLesson } from "./helpers/lesson-conformance.mjs";

const fixedNow = Date.parse("2026-08-18T00:00:00.000Z");
async function withRegistry(body, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "lesson-registry-"));
  let registry;
  try {
    registry = await LessonRegistry.open({ root, now: () => fixedNow, authorizedHumanIdentities: ["safety-owner"], ...options });
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
  assert.equal(proposed.record.repository.revision, candidate.provenance.repositoryRevision);
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

test("concurrent proposals serialize version/content admission before persistence", async () => withRegistry(async (registry, root) => {
  const first = lesson({ id: "lesson-concurrent" });
  const second = lesson({ id: "lesson-concurrent", behavior: { kind: "avoid", description: "use an independent safe action", action: "request-review", target: "concurrent-target" } });
  const results = await Promise.allSettled([registry.propose(first), registry.propose(second)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.reason instanceof LessonRegistryConflictError);
  const stored = registry.get("lesson-concurrent");
  assert.ok(stored);
  assert.equal(registry.list().lessons.length, 1);
  await registry.close();
  const reopened = await LessonRegistry.open({ root, now: () => fixedNow });
  try {
    assert.equal(reopened.get("lesson-concurrent").contentDigest, stored.contentDigest);
  } finally { await reopened.close(); }
}));

test("transitions reject evaluated lessons that were never admitted", async () => withRegistry(async (registry) => {
  const unadmitted = lesson({
    id: "lesson-unadmitted-evaluated",
    state: "evaluated",
    evaluation: { identity: "evaluation-unadmitted", evaluatedAt: "2026-08-17T00:00:00.000Z", score: 0.9 },
    stateHistory: [{ from: "proposed", to: "evaluated", changedAt: "2026-08-17T00:00:00.000Z", actorId: "lesson-evaluator" }],
  });
  await assert.rejects(registry.promote(unadmitted), (error) => error.code === "lesson_not_found");
  assert.equal(registry.get(unadmitted.id), undefined);
}));

test("immutable transition conflicts fail before append and reopen cleanly", async () => withRegistry(async (registry, root) => {
  const candidate = lesson({ id: "lesson-transition-conflict" });
  await registry.propose(candidate);
  const changed = lesson({
    id: candidate.id,
    behavior: { kind: "avoid", description: "changed immutable content", action: "request-review", target: "changed-target" },
  });
  await assert.rejects(registry.evaluate(changed, { identity: "evaluation-conflict" }), (error) => error instanceof LessonRegistryConflictError && error.code === "lesson_version_conflict");
  assert.equal(registry.get(candidate.id).state, "proposed");
  await registry.close();
  const reopened = await LessonRegistry.open({ root, now: () => fixedNow });
  try {
    assert.equal(reopened.get(candidate.id).state, "proposed");
    assert.equal(reopened.get(candidate.id).contentDigest, candidate.contentDigest);
  } finally { await reopened.close(); }
}));

test("ordinary proposed lessons cannot bypass evaluation", async () => withRegistry(async (registry) => {
  const candidate = lesson({ id: "lesson-proposed-promotion" });
  await registry.propose(candidate);
  await assert.rejects(registry.promote(candidate.id), (error) => error instanceof LessonRegistryPromotionError && error.code === "evaluation_required");
  assert.equal(registry.get(candidate.id).state, "proposed");
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

test("catastrophic promotion requires an authorized bound human decision", async () => withRegistry(async (registry) => {
  const candidate = catastrophicLesson();
  await registry.propose(candidate);
  await assert.rejects(registry.promote(candidate.id), (error) => error.code === "catastrophic_exception_approver_unauthorized");
  assert.equal(registry.get(candidate.id).state, "proposed");
}, { authorizedHumanIdentities: [] }));

test("promotion detects contradictory overlapping behavior rather than choosing a winner", async () => withRegistry(async (registry) => {
  const first = lesson({ id: "lesson-repeat", behavior: { kind: "repeat", description: "repeat the safe operation", action: "retry" } });
  await proposeAndEvaluate(registry, first);
  await registry.promote(first.id);
  const second = lesson({ id: "lesson-avoid", behavior: { kind: "avoid", description: "avoid the same operation", action: "stop" } });
  await proposeAndEvaluate(registry, second);
  await assert.rejects(registry.promote(second.id), (error) => error.code === "conflict_detected");
  assert.equal(registry.get(second.id).state, "evaluated");
}));

test("lessons require immutable repository provenance before admission", async () => withRegistry(async (registry) => {
  const candidate = lesson({ id: "lesson-missing-revision" });
  delete candidate.provenance.repositoryRevision;
  await assert.rejects(registry.propose(candidate), (error) => error.code === "lesson_invalid");
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

test("history queries are bounded by record and byte limits", async () => withRegistry(async (registry) => {
  await registry.propose(lesson({ id: "lesson-history-a" }));
  await registry.propose(lesson({ id: "lesson-history-b" }));
  const result = registry.list({ includeHistory: true, historyLimit: 1, maxBytes: 1024 * 1024 });
  assert.equal(result.history.length, 1);
  assert.equal(result.historyTruncated, true);
}));

test("rebuild rejects lesson artifacts whose repository provenance binding is altered", async () => {
  const candidate = lesson({ id: "lesson-binding" });
  const bytes = new TextEncoder().encode(canonicalJson(candidate));
  const artifact = {
    identity: `lesson-v1-${sha256Hex(`${candidate.id}\u0000${candidate.version}\u0000${candidate.contentDigest}`)}`,
    digest: sha256Hex(bytes),
    size: bytes.byteLength,
  };
  const eventId = `lesson-v1-${sha256Hex(`${candidate.id}\u0000${candidate.version}\u0000${candidate.state}\u0000${candidate.contentDigest}`)}`;
  const episodeId = `lesson-episode-${sha256Hex(candidate.id)}`;
  const fakeLedger = {
    async *streamRecords() {
      yield { record: { event: { kind: "lesson", id: eventId }, episode: { id: episodeId }, repository: { revision: "b".repeat(40) } }, artifacts: [artifact] };
    },
    async readArtifact() { return bytes; },
  };
  const registry = new LessonRegistry({ ledger: fakeLedger, now: () => fixedNow });
  await assert.rejects(registry.rebuild(), (error) => error.code === "lesson_artifact_binding_invalid");
});

test("generic raw ledger writers cannot forge registry lifecycle admissions after reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "lesson-registry-raw-promotion-"));
  let registry;
  try {
    registry = await LessonRegistry.open({ root, now: () => fixedNow, authorizedHumanIdentities: ["safety-owner"] });
    const candidate = lesson({ id: "lesson-raw-promotion" });
    const proposed = await registry.propose(candidate);
    await registry.close();
    const attackerCapability = Object.freeze({});
    const ledger = await EpisodeEvolutionLedger.open({ root, lessonAdmissionCapability: attackerCapability });
    try {
      for (const state of ["evaluated", "promoted"]) {
        const forged = lesson({ id: candidate.id, state });
        const bytes = new TextEncoder().encode(canonicalJson(forged));
        const eventId = `lesson-v1-${sha256Hex(`${forged.id}\u0000${forged.version}\u0000${forged.state}\u0000${forged.contentDigest}`)}`;
        const rawRecord = structuredClone(proposed.record);
        rawRecord.sequence = 1;
        rawRecord.event = { ...rawRecord.event, id: eventId };
        rawRecord.agentRun = { ...rawRecord.agentRun, runId: `lesson-run-${sha256Hex(eventId).slice(0, 48)}` };
        await assert.rejects(ledger.appendEpisodeWithArtifactBatch(rawRecord, {
          artifacts: [{
            bytes,
            metadata: {
              identity: `lesson-v1-${sha256Hex(`${forged.id}\u0000${forged.version}\u0000${forged.contentDigest}`)}`,
              evidenceClass: "caller_claim",
              coverage: "partial",
              provenance: canonicalJson({ lessonId: forged.id, version: forged.version, state: forged.state }),
              sensitivity: "internal",
            },
          }],
          capability: attackerCapability,
          lessonAdmission: { version: 1 },
        }), (error) => error.code === "lesson_admission_namespace_reserved");
      }
      const forged = lesson({ id: candidate.id, state: "promoted" });
      const bytes = new TextEncoder().encode(canonicalJson(forged));
      await assert.rejects(ledger.appendLesson(forged, { record: structuredClone(proposed.record), artifact: { bytes, metadata: { identity: "lesson-v1-forged", evidenceClass: "caller_claim", coverage: "partial", provenance: "{}", sensitivity: "internal" } }, capability: attackerCapability }), (error) => error.code === "lesson_admission_invalid");
    } finally { await ledger.close(); }
    registry = await LessonRegistry.open({ root, now: () => fixedNow, authorizedHumanIdentities: ["safety-owner"] });
    assert.equal(registry.get(candidate.id).state, "proposed");
  } finally {
    await registry?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuild rejects oversized lesson artifacts before reading their bytes", async () => {
  let read = false;
  const fakeLedger = {
    async *streamRecords() { yield { record: { event: { kind: "lesson" } }, artifacts: [{ identity: "lesson-v1-oversized", size: 2_000, digest: "a".repeat(64) }] }; },
    async readArtifact() { read = true; throw new Error("must not read"); },
  };
  const registry = new LessonRegistry({ ledger: fakeLedger, now: () => fixedNow, limits: { maxLessonBytes: 1 } });
  await assert.rejects(registry.rebuild(), (error) => error.code === "lesson_oversized");
  assert.equal(read, false);
});

test("bounded streams refuse an incomplete listRecords fallback", async () => {
  const fakeLedger = {
    async listRecords() { return { records: [], truncated: true }; },
  };
  const registry = new LessonRegistry({ ledger: fakeLedger, now: () => fixedNow });
  await assert.rejects(registry.rebuild({ batchSize: 1 }), (error) => error instanceof LessonRegistryError && error.code === "ledger_stream_truncated");
});

test("injected ledgers bind and reuse a durable registry authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "lesson-registry-injected-"));
  const ledger = await EpisodeEvolutionLedger.open({ root, lessonAdmissionCapability: Object.freeze({}) });
  let registry;
  try {
    registry = await LessonRegistry.open({ ledger, now: () => fixedNow });
    const result = await registry.propose(lesson({ id: "lesson-injected-ledger" }));
    const episode = await ledger.queryEpisode(result.record.episode.id);
    assert.equal(episode.records[0].lessonAdmission.version, 1);
    assert.equal(episode.records[0].lessonAdmission.algorithm, "ed25519");
    assert.match(episode.records[0].lessonAdmission.authority, /^[a-f0-9]{64}$/);
    assert.match(episode.records[0].lessonAdmission.binding, /^[a-f0-9]{64}$/);
    assert.match(episode.records[0].lessonAdmission.signature, /^[A-Za-z0-9_-]{80,128}$/);
    assert.equal(verifyLessonAdmission(episode.records[0], episode.records[0].lessonAdmission, ledger.getLessonAdmissionAuthority()), true);
    assert.equal(verifyLessonAdmission({ ...episode.records[0], previousDigest: "a".repeat(64) }, episode.records[0].lessonAdmission, ledger.getLessonAdmissionAuthority()), false);
    assert.equal(verifyLessonAdmission({ ...episode.records[0], receiptBatch: { ...episode.records[0].receiptBatch, id: `b${episode.records[0].receiptBatch.id.slice(1)}` } }, episode.records[0].lessonAdmission, ledger.getLessonAdmissionAuthority()), false);
    assert.match(ledger.getLessonAdmissionAuthority(), /^[A-Za-z0-9+/]+={0,2}$/);
    await registry.close();
    const reopenedLedger = await EpisodeEvolutionLedger.open({ root, lessonAdmissionCapability: Object.freeze({}) });
    try {
      const reopened = await LessonRegistry.open({ ledger: reopenedLedger, now: () => fixedNow });
      try { assert.equal(reopened.get("lesson-injected-ledger").state, "proposed"); }
      finally { await reopened.close(); }
    } finally { await reopenedLedger.close(); }
  } finally { await registry?.close(); await ledger.close(); await rm(root, { recursive: true, force: true }); }
});

test("reopening without the registry private authority fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "lesson-registry-authority-loss-"));
  let registry;
  try {
    registry = await LessonRegistry.open({ root, now: () => fixedNow });
    await registry.propose(lesson({ id: "lesson-authority-loss" }));
    await registry.close();
    await unlink(join(root, ".lesson-registry-authority.json"));
    await assert.rejects(LessonRegistry.open({ root, now: () => fixedNow }), (error) => error.code === "lesson_admission_authority_conflict");
  } finally { await registry?.close(); await rm(root, { recursive: true, force: true }); }
});

test("a raw writer cannot select the durable registry authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "lesson-registry-authority-selection-"));
  try {
    const { publicKey } = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "der" } });
    const raw = await EpisodeEvolutionLedger.open({ root, lessonAdmissionAuthority: publicKey.toString("base64") });
    await raw.close();
    await assert.rejects(LessonRegistry.open({ root, now: () => fixedNow }), (error) => error.code === "lesson_admission_authority_conflict");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("registry-owned backups preserve the private authority for restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "lesson-registry-backup-"));
  const restoredRoot = await mkdtemp(join(tmpdir(), "lesson-registry-restored-"));
  let registry;
  let restoredLedger;
  try {
    registry = await LessonRegistry.open({ root, now: () => fixedNow });
    await registry.propose(lesson({ id: "lesson-backup-restore" }));
    const backup = await registry.backup();
    await registry.close();
    restoredLedger = await EpisodeEvolutionLedger.restore({ backupPath: backup.path, root: restoredRoot });
    const reopened = await LessonRegistry.open({ ledger: restoredLedger, now: () => fixedNow });
    try { assert.equal(reopened.get("lesson-backup-restore").state, "proposed"); }
    finally { await reopened.close(); restoredLedger = undefined; }
  } finally {
    await registry?.close();
    await restoredLedger?.close();
    await rm(root, { recursive: true, force: true });
    await rm(restoredRoot, { recursive: true, force: true });
  }
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
