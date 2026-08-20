import { assertLessonTransitionV1, assertLessonV1, lessonDigestV1, validateLessonV1 } from "../contracts/lesson-v1.mjs";

export { lessonDigestV1 } from "../contracts/lesson-v1.mjs";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const stable = (value) => value === undefined ? "null" : value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
const artifactIdentity = (lesson) => `lesson-v1:${lesson.id}:${lesson.version}`;
const clone = (value) => structuredClone(value);

export class LessonRegistryError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "LessonRegistryError"; this.code = code; this.details = details; }
}

function secureError(code, message, error) {
  return new LessonRegistryError(code, message, { causeCode: typeof error?.code === "string" ? error.code : "unexpected_error" });
}

function ticketKeys(lesson) { return new Set(lesson.evidence.map((item) => `${item.ticket.system}\0${item.ticket.id}`)); }
function emergencyPermitted(lesson) {
  return lesson.risk === "catastrophic" && lesson.behavior.kind === "avoid" && lesson.catastrophicSafety?.narrowProhibition === true && typeof lesson.catastrophicSafety.authorizedBy === "string";
}
function conditionSet(lesson) { return new Set(lesson.applicability.conditions.map((condition) => condition.trim().toLowerCase())); }
function defaultOverlap(left, right) {
  if (left.id === right.id || left.applicability.scope !== right.applicability.scope) return false;
  const rightConditions = conditionSet(right);
  return [...conditionSet(left)].some((condition) => rightConditions.has(condition));
}
function defaultConflict(left, right) {
  if (!defaultOverlap(left, right)) return false;
  const kinds = new Set([left.behavior.kind, right.behavior.kind]);
  return (kinds.has("repeat") && kinds.has("avoid")) || (left.behavior.kind === right.behavior.kind && left.behavior.instruction !== right.behavior.instruction);
}

/**
 * Versioned facade over EpisodeEvolutionLedger. Lesson JSON is admitted as a
 * content-addressed artifact in the same durable batch as its Ticket Episode
 * event. The underlying ledger never imports this module or lesson validation.
 */
export class LessonRegistry {
  constructor({ ledger, batchSize = 128, maxScanRecords = 4096, detectorTimeoutMs = 5000, conflictDetector = defaultConflict, overlapDetector = defaultOverlap } = {}) {
    if (!ledger || typeof ledger.appendEpisodeWithArtifactBatch !== "function" || typeof ledger.readArtifact !== "function") throw new LessonRegistryError("ledger_invalid", "a compatible EpisodeEvolutionLedger is required");
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || !Number.isSafeInteger(maxScanRecords) || maxScanRecords < batchSize || !Number.isSafeInteger(detectorTimeoutMs) || detectorTimeoutMs < 1) throw new LessonRegistryError("bounds_invalid", "registry bounds are invalid");
    if (typeof conflictDetector !== "function" || typeof overlapDetector !== "function") throw new LessonRegistryError("detector_invalid", "conflict and overlap detectors are required");
    this.ledger = ledger; this.batchSize = batchSize; this.maxScanRecords = maxScanRecords; this.detectorTimeoutMs = detectorTimeoutMs; this.conflictDetector = conflictDetector; this.overlapDetector = overlapDetector;
    this.latest = new Map(); this.versions = new Map(); this.initialized = false; this.queue = Promise.resolve();
  }

  async *#streamEntries() {
    if (typeof this.ledger.streamRecords === "function") {
      const stream = this.ledger.streamRecords({ batchSize: this.batchSize, maxRecords: this.maxScanRecords });
      let count = 0;
      for await (const value of stream) {
        const entries = Array.isArray(value) ? value : [value];
        for (const entry of entries) { if (++count > this.maxScanRecords) throw new LessonRegistryError("scan_limit_exceeded", "lesson rebuild exceeded its configured record bound"); yield entry; }
      }
      return;
    }
    if (typeof this.ledger.listRecords !== "function") throw new LessonRegistryError("stream_unavailable", "ledger does not expose a bounded record scan");
    const page = await this.ledger.listRecords({ limit: this.maxScanRecords });
    if (page.truncated) throw new LessonRegistryError("scan_incomplete", "bounded ledger scan was truncated; a streaming adapter is required");
    for (let offset = 0; offset < page.records.length; offset += this.batchSize) for (const entry of page.records.slice(offset, offset + this.batchSize)) yield entry;
  }

  async #lessonFromEntry(entry) {
    if (entry?.record?.event?.kind !== "lesson" || !Array.isArray(entry.artifacts)) return undefined;
    const reference = entry.artifacts.find((item) => typeof item?.identity === "string" && item.identity.startsWith("lesson-v1:"));
    if (!reference) return undefined;
    let lesson;
    try { lesson = JSON.parse(decoder.decode(await this.ledger.readArtifact(reference))); }
    catch (error) { throw secureError("lesson_artifact_invalid", "a lesson artifact could not be decoded", error); }
    const validation = validateLessonV1(lesson);
    if (!validation.ok || reference.identity !== artifactIdentity(lesson) || reference.digest !== lessonDigestV1(lesson)) throw new LessonRegistryError("lesson_artifact_invalid", "a lesson artifact failed identity or contract validation");
    if (entry.record.episode?.id !== `lesson:${lesson.id}` || entry.record.sequence !== lesson.version - 1) throw new LessonRegistryError("lesson_record_mismatch", "a lesson artifact does not match its durable Ticket Episode record");
    return lesson;
  }

  async #rebuildFromLedger() {
    const nextLatest = new Map(), nextVersions = new Map();
    for await (const entry of this.#streamEntries()) {
      const lesson = await this.#lessonFromEntry(entry); if (!lesson) continue;
      const key = `${lesson.id}\0${lesson.version}`;
      if (nextVersions.has(key) && lessonDigestV1(nextVersions.get(key)) !== lessonDigestV1(lesson)) throw new LessonRegistryError("version_conflict", "two durable artifacts claim the same lesson version");
      nextVersions.set(key, lesson);
      const previous = nextLatest.get(lesson.id);
      if (!previous || lesson.version > previous.version) nextLatest.set(lesson.id, lesson);
    }
    for (const lesson of nextLatest.values()) {
      for (let version = 1; version <= lesson.version; version += 1) if (!nextVersions.has(`${lesson.id}\0${version}`)) throw new LessonRegistryError("lineage_incomplete", "durable lesson lineage has a missing version");
      for (let version = 2; version <= lesson.version; version += 1) assertLessonTransitionV1(nextVersions.get(`${lesson.id}\0${version - 1}`), nextVersions.get(`${lesson.id}\0${version}`));
    }
    this.latest = nextLatest; this.versions = nextVersions; this.initialized = true;
    return { lessons: nextLatest.size, versions: nextVersions.size };
  }

  #serialize(work) { const result = this.queue.then(work, work); this.queue = result.then(() => {}, () => {}); return result; }
  async #ready() { if (!this.initialized) await this.#rebuildFromLedger(); }
  async rebuild() { return this.#serialize(() => this.#rebuildFromLedger()); }
  #activeLessons(exceptId) { return [...this.latest.values()].filter((lesson) => lesson.id !== exceptId && ["evaluated", "promoted", "monitored"].includes(lesson.state)); }
  async #runDetector(detector, lesson, candidate) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(() => detector(lesson, candidate)), new Promise((_, reject) => { timer = setTimeout(() => reject(new LessonRegistryError("detector_timeout", "lesson detector timed out")), this.detectorTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  }

  async #detectOverlaps(lesson) {
    const matches = [];
    for (const candidate of this.#activeLessons(lesson.id)) {
      let overlaps; try { overlaps = await this.#runDetector(this.overlapDetector, lesson, candidate); } catch (error) { throw secureError("overlap_detection_failed", "lesson overlap detection failed closed", error); }
      if (overlaps === true) matches.push(clone(candidate));
    }
    return matches;
  }

  async #detectConflicts(lesson) {
    const matches = [];
    for (const candidate of this.#activeLessons(lesson.id)) {
      let conflicts; try { conflicts = await this.#runDetector(this.conflictDetector, lesson, candidate); } catch (error) { throw secureError("conflict_detection_failed", "lesson conflict detection failed closed", error); }
      if (conflicts === true) matches.push(clone(candidate));
    }
    return matches;
  }
  async detectOverlaps(lesson) { return this.#serialize(async () => { await this.#ready(); return this.#detectOverlaps(lesson); }); }
  async detectConflicts(lesson) { return this.#serialize(async () => { await this.#ready(); return this.#detectConflicts(lesson); }); }

  async #activePolicy(lesson) {
    if (lesson.evidence.length === 0) throw new LessonRegistryError("evidence_required", "an active lesson requires evidence");
    if (ticketKeys(lesson).size < 2 && !emergencyPermitted(lesson)) throw new LessonRegistryError("evidence_breadth_insufficient", "one-ticket hypotheses cannot become active");
    const [overlaps, conflicts] = await Promise.all([this.#detectOverlaps(lesson), this.#detectConflicts(lesson)]);
    if (conflicts.length) { const resolved = new Set(lesson.conflictResolution?.lessonIds ?? []); if (conflicts.some((candidate) => !resolved.has(candidate.id))) throw new LessonRegistryError("unresolved_conflict", "active lesson has unresolved conflicting lessons", { lessonIds: conflicts.map(({ id }) => id) }); }
    return { overlaps, conflicts };
  }

  async #admit(lesson, record, previous) {
    if (!record || record.event?.kind !== "lesson" || record.episode?.id !== `lesson:${lesson.id}` || record.sequence !== lesson.version - 1) throw new LessonRegistryError("episode_record_invalid", "lesson admission requires a matching lesson Ticket Episode event");
    if (previous) assertLessonTransitionV1(previous, lesson); else assertLessonV1(lesson);
    const bytes = encoder.encode(stable(lesson));
    let result;
    try { result = await this.ledger.appendEpisodeWithArtifactBatch(record, { artifacts: [{ bytes, metadata: { identity: artifactIdentity(lesson), evidenceClass: "lesson_evidence", coverage: "cited", provenance: lessonDigestV1(lesson), sensitivity: "internal" } }] }); }
    catch (error) { throw secureError("ledger_admission_failed", "durable lesson admission failed", error); }
    this.versions.set(`${lesson.id}\0${lesson.version}`, clone(lesson)); this.latest.set(lesson.id, clone(lesson));
    return { ...result, lesson: clone(lesson) };
  }

  async propose(lesson, record) { return this.#serialize(async () => { await this.#ready(); if (lesson.state !== "proposed" || lesson.version !== 1) throw new LessonRegistryError("proposal_invalid", "a proposal must be version 1 in proposed state"); if (this.latest.has(lesson.id)) throw new LessonRegistryError("lesson_exists", "lesson identity already exists"); return this.#admit(lesson, record); }); }
  async #transition(lesson, record) { return this.#serialize(async () => { await this.#ready(); const previous = this.latest.get(lesson.id); if (!previous) throw new LessonRegistryError("lesson_missing", "lesson identity is not registered"); return this.#admit(lesson, record, previous); }); }
  async evaluate(lesson, record) { if (lesson.state !== "evaluated") throw new LessonRegistryError("target_state_invalid", "evaluate requires evaluated state"); return this.#transition(lesson, record); }
  async #activate(lesson, record) { return this.#serialize(async () => {
    await this.#ready(); const previous = this.latest.get(lesson.id); if (!previous) throw new LessonRegistryError("lesson_missing", "lesson identity is not registered"); assertLessonTransitionV1(previous, lesson);
    const { overlaps, conflicts } = await this.#activePolicy(lesson);
    const admitted = await this.#admit(lesson, record, previous); return { ...admitted, overlaps: overlaps.map(({ id, version }) => ({ id, version })), conflicts: conflicts.map(({ id, version }) => ({ id, version })) };
  }); }
  async promote(lesson, record) { if (lesson.state !== "promoted") throw new LessonRegistryError("target_state_invalid", "promote requires promoted state"); return this.#activate(lesson, record); }
  async monitor(lesson, record) { if (lesson.state !== "monitored") throw new LessonRegistryError("target_state_invalid", "monitor requires monitored state"); return this.#activate(lesson, record); }
  async revert(lesson, record) { if (lesson.state !== "reverted") throw new LessonRegistryError("target_state_invalid", "revert requires reverted state"); return this.#transition(lesson, record); }
  async retire(lesson, record) { if (lesson.state !== "retired") throw new LessonRegistryError("target_state_invalid", "retire requires retired state"); return this.#transition(lesson, record); }
  async supersede(lesson, record) { if (lesson.state !== "superseded") throw new LessonRegistryError("target_state_invalid", "supersede requires superseded state"); return this.#transition(lesson, record); }
  async reject(lesson, record) { if (lesson.state !== "rejected") throw new LessonRegistryError("target_state_invalid", "reject requires rejected state"); return this.#transition(lesson, record); }

  async get(id, version) { return this.#serialize(async () => { await this.#ready(); const lesson = version === undefined ? this.latest.get(id) : this.versions.get(`${id}\0${version}`); return lesson && clone(lesson); }); }
  async list({ states } = {}) { return this.#serialize(async () => { await this.#ready(); const allowed = states ? new Set(states) : undefined; return [...this.latest.values()].filter((lesson) => !allowed || allowed.has(lesson.state)).map(clone); }); }
  async listStale({ asOf = new Date().toISOString() } = {}) { return this.#serialize(async () => { await this.#ready(); const time = Date.parse(asOf); if (!Number.isFinite(time)) throw new LessonRegistryError("as_of_invalid", "staleness time is invalid"); return [...this.latest.values()].filter((lesson) => lesson.applicability.expiresAt && Date.parse(lesson.applicability.expiresAt) <= time && !["retired", "superseded", "rejected"].includes(lesson.state)).map(clone); }); }
  async ruleAccumulation({ scope, maximum = 100 } = {}) { return this.#serialize(async () => { await this.#ready(); if (!Number.isSafeInteger(maximum) || maximum < 1) throw new LessonRegistryError("maximum_invalid", "rule accumulation maximum is invalid"); const lessons = [...this.latest.values()].filter((lesson) => ["promoted", "monitored"].includes(lesson.state) && (!scope || lesson.applicability.scope === scope)); return { count: lessons.length, exceedsMaximum: lessons.length > maximum, lessons: lessons.slice(0, maximum).map(({ id, version, applicability }) => ({ id, version, scope: applicability.scope })), truncated: lessons.length > maximum }; }); }
}
