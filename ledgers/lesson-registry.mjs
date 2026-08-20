import { TextEncoder } from "node:util";
import { EpisodeEvolutionLedger } from "./episode-evolution-ledger.mjs";
import {
  LessonValidationError,
  canonicalJson,
  isCatastrophicSafetyException,
  lessonDigest,
  validateLessonTransition,
  validateLessonV1,
} from "../contracts/lesson-v1.mjs";

const encoder = new TextEncoder();
const hashIdentity = (domain, value) => `${domain}-${lessonDigest({ domain, value })}`;
const recordId = (lesson) => hashIdentity("lesson-event", `${lesson.lesson.id}\u0000${lesson.lesson.revision}`);
const artifactMetadata = (lesson) => ({ identity: "lesson-v1", evidenceClass: "caller_claim", coverage: "partial", provenance: "lesson-registry", sensitivity: "internal" });
const safeError = (error) => ({ code: error?.code ?? "registry_scan_failed", message: "lesson registry operation failed" });
const promotionEvidenceAllowed = (lesson) => new Set(lesson.evidence.map((entry) => `${entry.ticket.system}\u0000${entry.ticket.id}`)).size >= 2 || isCatastrophicSafetyException(lesson);
const lessonsConflict = (left, right) => left.behavior.subject === right.behavior.subject
  && left.applicability.repositories.some((value) => right.applicability.repositories.includes(value))
  && left.applicability.taskKinds.some((value) => right.applicability.taskKinds.includes(value))
  && new Set(["avoid:require", "require:avoid"]).has(`${left.behavior.action}:${right.behavior.action}`);

export class LessonRegistryError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "LessonRegistryError"; this.code = code; this.details = details; }
}

/**
 * A narrow, unidirectional Lesson v1 facade. It only writes canonical lesson
 * snapshots to EpisodeEvolutionLedger; the lower ledger imports no lesson code
 * and never evaluates promotion, conflicts, or lifecycle rules.
 */
export class LessonRegistry {
  static async open({ root, ledger, limits = {}, faultInjector } = {}) {
    const backing = ledger ?? await EpisodeEvolutionLedger.open({ root, limits, faultInjector });
    const registry = new LessonRegistry({ ledger: backing, ownsLedger: !ledger, limits });
    try { await registry.rebuild(); return registry; }
    catch (error) { if (!ledger) await backing.close(); throw error; }
  }

  #ledger;
  #ownsLedger;
  #lessons = new Map();
  #admissions = Promise.resolve();
  constructor({ ledger, ownsLedger = false, limits = {} } = {}) {
    if (!ledger || typeof ledger !== "object") throw new LessonRegistryError("ledger_required", "a backing EpisodeEvolutionLedger is required");
    this.#ledger = ledger;
    this.#ownsLedger = ownsLedger;
    this.limits = Object.freeze({ maxScanRecords: limits.maxScanRecords ?? 100_000, maxScanBatches: limits.maxScanBatches ?? (limits.maxScanRecords ?? 100_000), maxConflictFindings: limits.maxConflictFindings ?? 256, maxRebuildBatch: limits.maxRebuildBatch ?? 256 });
    for (const [key, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new LessonRegistryError("limit_invalid", `${key} must be a positive integer`);
  }

  async close() { if (this.#ownsLedger) await this.#ledger.close(); }
  #enqueue(work) { const next = this.#admissions.catch(() => {}).then(work); this.#admissions = next.then(() => {}, () => {}); return next; }
  #next(previous, state) { return { ...structuredClone(previous), lesson: { ...previous.lesson, revision: previous.lesson.revision + 1 }, state }; }
  #record(lesson, sequence) {
    const first = lesson.evidence[0];
    return {
      schema: { id: "https://pi-sampler.dev/contracts/ticket-episode/v1", version: "1.0.0" },
      project: { id: "pi-sampler" }, repository: { id: "lesson-registry", revision: "0".repeat(40) },
      ticket: { system: "lesson-registry", id: hashIdentity("lesson", lesson.lesson.id) },
      episode: { id: hashIdentity("lesson-episode", lesson.lesson.id) },
      attempt: { id: hashIdentity("lesson-attempt", `${lesson.lesson.id}\u0000${lesson.lesson.revision}`) },
      session: { id: hashIdentity("lesson-session", lesson.lesson.id) },
      agentRun: { agentId: "lesson-registry", runId: hashIdentity("lesson-run", lesson.lesson.id) },
      event: { id: recordId(lesson), kind: "lesson" }, producer: { id: "lesson-registry", kind: "pi_extension" },
      occurredAt: lesson.provenance.createdAt, sequence,
      evidence: { class: "caller_claim", authority: { level: "untrusted" } },
      state: "partial", coverage: { status: "partial", expectedEventCount: 2, observedEventCount: 1, missingEventIds: [`evidence-${first.eventId}`] },
    };
  }
  async *#streamRecords(batchSize = this.limits.maxRebuildBatch) {
    if (typeof this.#ledger.streamRecords === "function") {
      let records = 0, batches = 0;
      for await (const batch of this.#ledger.streamRecords({ batchSize })) {
        if (++batches > this.limits.maxScanBatches || !Array.isArray(batch) || batch.length > batchSize) throw new LessonRegistryError("ledger_scan_truncated", "ledger stream exceeds configured safe bounds");
        records += batch.length;
        if (records > this.limits.maxScanRecords) throw new LessonRegistryError("ledger_scan_truncated", "ledger stream exceeds configured safe bounds");
        yield* batch;
      }
      return;
    }
    const listed = await this.#ledger.listRecords({ limit: this.limits.maxScanRecords });
    if (!listed || !Array.isArray(listed.records) || listed.truncated) throw new LessonRegistryError("ledger_scan_truncated", "a bounded ledger scan cannot safely rebuild the registry");
    yield* listed.records;
  }
  async *#streamLessons(batchSize) {
    for await (const entry of this.#streamRecords(batchSize)) {
      if (entry?.record?.event?.kind !== "lesson") continue;
      const artifact = entry.artifacts?.find((candidate) => candidate?.identity === "lesson-v1" && candidate.evidenceClass === "caller_claim");
      if (!artifact) throw new LessonRegistryError("persisted_lesson_invalid", "lesson event lacks its canonical lesson artifact");
      let lesson;
      try { lesson = JSON.parse(new TextDecoder().decode(await this.#ledger.readArtifact(artifact))); }
      catch { throw new LessonRegistryError("persisted_lesson_invalid", "lesson artifact is not readable canonical JSON"); }
      if (lessonDigest(lesson) !== artifact.digest || !validateLessonV1(lesson).ok) throw new LessonRegistryError("persisted_lesson_invalid", "lesson artifact fails immutable content validation");
      if (entry.record.event.id !== recordId(lesson)) throw new LessonRegistryError("persisted_lesson_invalid", "lesson event identity does not bind its artifact");
      yield lesson;
    }
  }
  async rebuild(options = {}) { return this.#enqueue(() => this.#rebuild(options)); }
  async #rebuild({ batchSize = this.limits.maxRebuildBatch } = {}) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > this.limits.maxRebuildBatch) throw new LessonRegistryError("rebuild_batch_invalid", "rebuild batch is outside configured bounds");
    const rebuilt = new Map();
    for await (const lesson of this.#streamLessons(batchSize)) {
      const prior = rebuilt.get(lesson.lesson.id);
      if (!prior) {
        if (lesson.lesson.revision !== 1 || lesson.state !== "proposed") throw new LessonRegistryError("persisted_lesson_lifecycle_invalid", "persisted lesson history must begin with proposed revision one");
      } else {
        const transition = validateLessonTransition(prior, lesson);
        if (!transition.ok) throw new LessonRegistryError("persisted_lesson_lifecycle_invalid", "persisted lesson transition is invalid");
      }
      if (lesson.state === "promoted" && !promotionEvidenceAllowed(lesson)) throw new LessonRegistryError("persisted_lesson_promotion_invalid", "persisted promotion lacks required evidence breadth");
      rebuilt.set(lesson.lesson.id, lesson);
    }
    const active = [...rebuilt.values()].filter((lesson) => ["proposed", "evaluated", "promoted", "monitored"].includes(lesson.state));
    for (let index = 0; index < active.length; index += 1) for (const candidate of active.slice(index + 1)) if (lessonsConflict(active[index], candidate)) throw new LessonRegistryError("persisted_lesson_conflict", "persisted active lessons conflict without explicit resolution");
    // Replacement is atomic: a bad stream leaves the previously usable cache intact.
    this.#lessons = rebuilt;
    return { lessons: rebuilt.size };
  }
  async get(id) { return this.#lessons.has(id) ? structuredClone(this.#lessons.get(id)) : undefined; }
  async list({ limit = this.limits.maxConflictFindings } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > this.limits.maxConflictFindings) throw new LessonRegistryError("query_limit_invalid", "lesson query limit is outside configured bounds");
    const lessons = [...this.#lessons.values()].sort((a, b) => a.lesson.id.localeCompare(b.lesson.id));
    return { lessons: lessons.slice(0, limit).map(structuredClone), truncated: lessons.length > limit };
  }
  async #persist(lesson) {
    const prior = this.#lessons.get(lesson.lesson.id);
    const sequence = prior ? prior.lesson.revision : 0;
    const bytes = encoder.encode(canonicalJson(lesson));
    const result = await this.#ledger.appendEpisodeWithArtifactBatch(this.#record(lesson, sequence), { artifacts: [{ bytes, metadata: artifactMetadata(lesson) }] });
    // Never update the cache before the lower ledger finishes durable admission.
    this.#lessons.set(lesson.lesson.id, structuredClone(lesson));
    return { status: result.status, lesson: structuredClone(lesson) };
  }
  async propose(lesson) { return this.#enqueue(async () => {
    const validation = validateLessonV1(lesson);
    if (!validation.ok) throw new LessonValidationError(validation.errors);
    if (lesson.state !== "proposed") throw new LessonRegistryError("proposal_state_invalid", "new lessons must begin proposed");
    const prior = this.#lessons.get(lesson.lesson.id);
    if (prior) {
      if (lessonDigest(prior) === lessonDigest(lesson)) return { status: "idempotent", lesson: structuredClone(prior) };
      throw new LessonRegistryError("lesson_exists", "lesson identity is already bound to immutable content");
    }
    return this.#persist(lesson);
  }); }
  async evaluate(id) { return this.#transition(id, "evaluated"); }
  async reject(id) { return this.#transition(id, "rejected"); }
  async monitor(id) { return this.#transition(id, "monitored"); }
  async revert(id) { return this.#transition(id, "reverted"); }
  async retire(id) { return this.#transition(id, "retired"); }
  async supersede(id) { return this.#transition(id, "superseded"); }
  async #transition(id, target) { return this.#enqueue(async () => {
    const prior = this.#lessons.get(id);
    if (!prior) throw new LessonRegistryError("lesson_missing", "lesson does not exist");
    const next = this.#next(prior, target), validation = validateLessonTransition(prior, next);
    if (!validation.ok) throw new LessonValidationError(validation.errors);
    return this.#persist(next);
  }); }
  async detectOverlaps(candidate) {
    const validation = validateLessonV1(candidate);
    if (!validation.ok) throw new LessonValidationError(validation.errors);
    const matches = [];
    try {
      for await (const stored of this.#streamLessons()) {
        const active = this.#lessons.get(stored.lesson.id);
        // Historical snapshots are immutable evidence, not active rules. Only
        // the cache-confirmed latest revision can participate in a conflict.
        if (stored.lesson.id === candidate.lesson.id || !active || active.lesson.revision !== stored.lesson.revision || !["proposed", "evaluated", "promoted", "monitored"].includes(active.state)) continue;
        const repositories = stored.applicability.repositories.filter((value) => candidate.applicability.repositories.includes(value));
        const taskKinds = stored.applicability.taskKinds.filter((value) => candidate.applicability.taskKinds.includes(value));
        if (repositories.length && taskKinds.length && stored.behavior.subject === candidate.behavior.subject) {
          matches.push({ lessonId: stored.lesson.id, revision: stored.lesson.revision, repositories, taskKinds });
          if (matches.length > this.limits.maxConflictFindings) throw new LessonRegistryError("conflict_scan_limit", "overlap findings exceed the configured safe bound");
        }
      }
      return matches;
    } catch (error) { if (error instanceof LessonValidationError || error instanceof LessonRegistryError) throw error; throw new LessonRegistryError("overlap_detection_failed", "overlap detection failed closed", { cause: safeError(error) }); }
  }
  async detectConflicts(candidate) {
    const overlaps = await this.detectOverlaps(candidate);
    const conflicts = [];
    for (const overlap of overlaps) {
      const stored = this.#lessons.get(overlap.lessonId);
      if (!stored) throw new LessonRegistryError("conflict_cache_missing", "streamed overlap result is absent from the active cache");
      if (lessonsConflict(stored, candidate)) conflicts.push(overlap);
    }
    return conflicts;
  }
  async promote(id) { return this.#enqueue(async () => {
    const prior = this.#lessons.get(id);
    if (!prior) throw new LessonRegistryError("lesson_missing", "lesson does not exist");
    if (prior.state !== "evaluated") throw new LessonRegistryError("promotion_state_invalid", "only evaluated lessons may be promoted");
    // Validate independently at the promotion boundary, including malformed or
    // absent exception metadata. No caller-controlled bypass is permissive.
    const validation = validateLessonV1(prior);
    if (!validation.ok) throw new LessonValidationError(validation.errors);
    if (!promotionEvidenceAllowed(prior)) throw new LessonRegistryError("promotion_evidence_breadth_insufficient", "promotion requires evidence from at least two tickets unless it is a catastrophic avoid exception");
    let conflicts; try { conflicts = await this.detectConflicts(prior); }
    catch (error) { throw new LessonRegistryError("promotion_conflict_detection_failed", "promotion denied because conflict detection did not complete", { cause: safeError(error) }); }
    if (conflicts.length) throw new LessonRegistryError("promotion_conflict_detected", "promotion requires explicit rejection or supersession of conflicting lessons", { conflicts });
    const next = this.#next(prior, "promoted"), transition = validateLessonTransition(prior, next);
    if (!transition.ok) throw new LessonValidationError(transition.errors);
    return this.#persist(next);
  }); }
}
