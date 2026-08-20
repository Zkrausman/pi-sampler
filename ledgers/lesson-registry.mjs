import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import { authorityForRoot, backupRegistryLedger, LESSON_AUTHORITY_FILE, readAuthorityPath, signedLessonAdmission, writeAuthority } from "./lesson-registry-authority.mjs";
import { EpisodeEvolutionLedger, verifyLessonAdmission } from "./episode-evolution-ledger.mjs";
import {
  LESSON_BEHAVIOR_KINDS,
  LESSON_LIFECYCLE_STATES,
  LESSON_RISK_LEVELS,
  LESSON_V1_SCHEMA_ID,
  LESSON_V1_SCHEMA_VERSION,
  canonicalJson,
  lessonContentDigest,
  normalizeLessonV1,
  validateCatastrophicSafetyException,
  validateLessonTransition,
  validateLessonV1,
} from "../contracts/lesson-v1.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ACTIVE_STATES = new Set(["proposed", "evaluated", "promoted", "monitored"]);
const TERMINAL_STATES = new Set(["reverted", "retired", "superseded", "rejected"]);
const DEFAULT_REGISTRY_LIMITS = Object.freeze({
  maxRebuildBatch: 256,
  maxQueryRecords: 1000,
  maxQueryBytes: 4 * 1024 * 1024,
  maxLessonBytes: 256 * 1024,
  maxActiveLessons: 4096,
  maxStoredVersions: 4096,
  maxConditionCount: 64,
  maxAgeMs: 90 * 24 * 60 * 60 * 1000,
  maxFutureSkewMs: 30 * 1000,
});
export { DEFAULT_REGISTRY_LIMITS };

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);
const compactErrorCode = (error) => typeof error?.code === "string" && /^[a-z0-9_:-]{1,96}$/.test(error.code) ? error.code : "unknown";
const compactErrors = (errors) => Array.isArray(errors) ? errors.slice(0, 32).map((error) => ({ code: compactErrorCode(error), path: typeof error?.path === "string" ? error.path.slice(0, 256) : "" })) : [];
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
const nowIso = (value) => {
  const result = typeof value === "function" ? value() : value;
  const date = result === undefined ? new Date() : (typeof result === "number" ? new Date(result) : new Date(result));
  if (!Number.isFinite(date.getTime())) throw new LessonRegistryError("clock_invalid", "lesson registry clock is invalid");
  return date.toISOString();
};

export class LessonRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LessonRegistryError";
    this.code = code;
    // Details are deliberately restricted to codes, identities, and bounded
    // counts. Raw lesson payloads and ledger errors never cross this facade.
    this.details = Object.fromEntries(Object.entries(details).filter(([key, value]) => {
      if (["error", "cause", "lesson", "payload", "record", "packet"].includes(key)) return false;
      return ["string", "number", "boolean"].includes(typeof value) || (Array.isArray(value) && value.length <= 32 && value.every((item) => typeof item === "string"));
    }));
  }
}
export class LessonRegistryValidationError extends LessonRegistryError {
  constructor(errors) { super("lesson_invalid", "lesson payload failed closed validation", { codes: compactErrors(errors).map((error) => error.code) }); this.name = "LessonRegistryValidationError"; this.errors = compactErrors(errors); }
}
export class LessonRegistryConflictError extends LessonRegistryError {
  constructor(code, message, details = {}) { super(code, message, details); this.name = "LessonRegistryConflictError"; }
}
export class LessonRegistryTransitionError extends LessonRegistryError {
  constructor(code, message, details = {}) { super(code, message, details); this.name = "LessonRegistryTransitionError"; }
}
export class LessonRegistryPromotionError extends LessonRegistryError {
  constructor(code, message, details = {}) { super(code, message, details); this.name = "LessonRegistryPromotionError"; }
}

function configuredLimits(limits = {}) {
  const result = { ...DEFAULT_REGISTRY_LIMITS, ...limits };
  for (const [key, value] of Object.entries(result)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid lesson registry limit ${key}`);
  return Object.freeze(result);
}

function lessonKey(lesson) { return `${lesson.id}\u0000${lesson.version}`; }
function contentKey(lesson) { return `${lesson.id}\u0000${lesson.version}\u0000${lesson.contentDigest}`; }
function eventIdentity(lesson) { return `lesson-v1-${sha256(`${lesson.id}\u0000${lesson.version}\u0000${lesson.state}\u0000${lesson.contentDigest}`)}`; }
function episodeIdentity(lesson) { return `lesson-episode-${sha256(lesson.id).slice(0, 64)}`; }
function artifactIdentity(lesson) { return `lesson-v1-${sha256(`${lesson.id}\u0000${lesson.version}\u0000${lesson.contentDigest}`).slice(0, 64)}`; }
function sourceTickets(lesson) { return new Set([...(lesson.provenance?.sourceTickets ?? []), ...(lesson.evidence ?? []).map((entry) => entry.ticketId).filter(Boolean)]); }
function sourceEpisodes(lesson) { return new Set([...(lesson.provenance?.sourceEpisodes ?? []), ...(lesson.evidence ?? []).map((entry) => entry.episodeId).filter(Boolean)]); }
function sourceEvents(lesson) { return new Set((lesson.evidence ?? []).map((entry) => entry.eventId).filter(Boolean)); }
function active(lesson) { return Boolean(lesson && ACTIVE_STATES.has(lesson.state)); }
function terminal(lesson) { return Boolean(lesson && TERMINAL_STATES.has(lesson.state)); }

function conditionValue(condition) {
  if (condition.value !== undefined) return String(condition.value);
  if (Array.isArray(condition.values)) return condition.values.map(String).sort().join("\u0001");
  return "";
}
function applicabilityOverlap(left, right) {
  const leftConditions = new Map((left.applicability?.conditions ?? []).map((condition) => [condition.field, condition]));
  const rightConditions = new Map((right.applicability?.conditions ?? []).map((condition) => [condition.field, condition]));
  let compared = 0;
  for (const [field, a] of leftConditions) {
    const b = rightConditions.get(field);
    if (!b) continue;
    compared += 1;
    const aValue = conditionValue(a), bValue = conditionValue(b);
    if (a.operator === "equals" && b.operator === "equals" && aValue !== bValue) return { overlaps: false, compared };
    if (a.operator === "not_equals" && b.operator === "equals" && aValue === bValue) return { overlaps: false, compared };
    if (b.operator === "not_equals" && a.operator === "equals" && aValue === bValue) return { overlaps: false, compared };
    if (a.operator === "not_exists" && b.operator === "exists") return { overlaps: false, compared };
    if (b.operator === "not_exists" && a.operator === "exists") return { overlaps: false, compared };
    if (a.operator === "exists" && b.operator === "not_exists") return { overlaps: false, compared };
    if (b.operator === "exists" && a.operator === "not_exists") return { overlaps: false, compared };
  }
  // No contradictory bounds means the conditions have a possible common
  // assignment. Unknown predicates intentionally overlap rather than silently
  // selecting a winner.
  return { overlaps: true, compared };
}
function behaviorConflict(left, right) {
  if (left.behavior.kind === right.behavior.kind) {
    const leftAction = left.behavior.action ?? left.behavior.target ?? "";
    const rightAction = right.behavior.action ?? right.behavior.target ?? "";
    return leftAction !== rightAction && leftAction !== "" && rightAction !== "";
  }
  return (left.behavior.kind === "repeat" && right.behavior.kind === "avoid") || (left.behavior.kind === "avoid" && right.behavior.kind === "repeat");
}
function safeLessonSummary(lesson, reason, conflict = false) {
  return { lessonId: lesson.id, version: lesson.version, state: lesson.state, reason, conflict };
}
export class LessonRegistry {
  static async open(options = {}) {
    let ledger = options.ledger;
    let admissionAuthority;
    let ownsLedger = false;
    let authorityState;
    if (!ledger) {
      if (typeof options.root !== "string" || options.root.length === 0) throw new LessonRegistryError("root_required", "lesson registry root is required");
      authorityState = await authorityForRoot(options.root);
      ledger = await EpisodeEvolutionLedger.open({ ...(options.ledgerOptions ?? {}), root: options.root, limits: options.ledgerLimits ?? options.ledgerOptions?.limits, lessonAdmissionAuthority: undefined });
      ownsLedger = true;
    } else {
      if (typeof ledger.root !== "string" || typeof ledger.getLessonAdmissionAuthority !== "function") throw new LessonRegistryError("lesson_admission_authority_required", "an injected ledger must expose its durable lesson admission authority");
      authorityState = await authorityForRoot(ledger.root, ledger.getLessonAdmissionAuthority());
    }
    admissionAuthority = authorityState.authority;
    try {
      const durableAuthority = ledger.getLessonAdmissionAuthority();
      if (durableAuthority !== undefined && durableAuthority !== admissionAuthority.publicKey) throw new LessonRegistryError("lesson_admission_authority_conflict", "registry authority does not match the durable ledger authority");
      if (durableAuthority === undefined) {
        if (authorityState.created) await writeAuthority(authorityState.path, admissionAuthority);
        if (typeof ledger.ensureLessonAdmissionAuthority !== "function") throw new LessonRegistryError("lesson_admission_authority_required", "an injected ledger cannot bind a durable lesson admission authority");
        await ledger.ensureLessonAdmissionAuthority(admissionAuthority.publicKey);
      }
      const registry = new LessonRegistry({ ...options, ledger, admissionAuthority });
      await registry.rebuild();
      return registry;
    } catch (error) { if (ownsLedger) await ledger.close().catch(() => {}); throw error; }
  }
  static async restore({ backupPath, root, registryAuthorityPath, ledgerLimits, trustedAuthorityIds, verifyAttestation, ...options } = {}) {
    if (typeof backupPath !== "string" || typeof root !== "string") throw new LessonRegistryError("restore_invalid", "backupPath and root are required");
    const source = await readAuthorityPath(registryAuthorityPath ?? `${resolve(backupPath)}.${LESSON_AUTHORITY_FILE}`);
    if (!source.authority) throw new LessonRegistryError("lesson_admission_authority_required", "registry restore requires its private authority sidecar");
    let ledger;
    try {
      ledger = await EpisodeEvolutionLedger.restore({ backupPath, root, limits: ledgerLimits, trustedAuthorityIds, verifyAttestation });
      await writeAuthority(join(resolve(root), LESSON_AUTHORITY_FILE), source.authority);
      await ledger.close();
      ledger = undefined;
      return LessonRegistry.open({ root, ...options });
    } catch (error) {
      await ledger?.close().catch(() => {});
      if (error instanceof LessonRegistryError) throw error;
      throw new LessonRegistryError("restore_failed", "lesson registry restore failed closed", { causeCode: compactErrorCode(error) });
    }
  }

  #ledger;
  #latest = new Map();
  #versions = new Map();
  #sequences = new Map();
  #rebuildPromise = Promise.resolve();
  #admissions = Promise.resolve();
  #authorizedHumanIdentities;
  #admissionAuthority;

  constructor({ ledger, projectId = "pi-sampler", repositoryId = "github.com/Zkrausman/pi-sampler", repositoryRevision = "0".repeat(40), ticket = { system: "lesson-registry", id: "LESSON-REGISTRY-V1" }, now = Date.now, limits = {}, currentRepositoryRevision, currentEvaluatorIdentity, authorizedHumanIdentities = [], admissionAuthority } = {}) {
    if (!ledger || typeof ledger !== "object") throw new LessonRegistryError("ledger_required", "an EpisodeEvolutionLedger facade is required");
    if (!identifier(projectId) || !identifier(repositoryId) || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(repositoryRevision) || !identifier(ticket.system) || !identifier(ticket.id)) throw new LessonRegistryError("registry_identity_invalid", "lesson registry identity is invalid");
    if (!Array.isArray(authorizedHumanIdentities) || authorizedHumanIdentities.length > 128 || authorizedHumanIdentities.some((value) => !identifier(value))) throw new LessonRegistryError("registry_identity_invalid", "authorized human identities are invalid");
    this.#ledger = ledger;
    this.projectId = projectId;
    this.repositoryId = repositoryId;
    this.repositoryRevision = repositoryRevision;
    this.ticket = Object.freeze({ system: ticket.system, id: ticket.id });
    this.now = now;
    this.limits = configuredLimits(limits);
    this.currentRepositoryRevision = currentRepositoryRevision;
    this.currentEvaluatorIdentity = currentEvaluatorIdentity;
    this.#authorizedHumanIdentities = new Set(authorizedHumanIdentities);
    this.#admissionAuthority = admissionAuthority;
    this.closed = false;
  }

  get ledger() { return this.#ledger; }
  async close() { if (!this.closed && typeof this.#ledger.close === "function") await this.#ledger.close(); this.closed = true; }
  async backup(options = {}) {
    this.#assertOpen();
    if (!this.#admissionAuthority || typeof this.#ledger.backup !== "function") throw new LessonRegistryError("backup_unavailable", "lesson registry backup requires a durable ledger backup API");
    try { return await backupRegistryLedger(this.#ledger, this.#admissionAuthority, options); }
    catch (error) { if (error instanceof LessonRegistryError) throw error; throw new LessonRegistryError("backup_failed", "lesson registry backup failed closed", { causeCode: compactErrorCode(error) }); }
  }

  #assertOpen() { if (this.closed) throw new LessonRegistryError("closed", "lesson registry is closed"); }
  #time() { return nowIso(this.now); }
  #prepare(input, expectedState) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new LessonRegistryValidationError([{ code: "lesson_invalid", path: "" }]);
    const candidate = clone(input);
    candidate.schema ??= { id: LESSON_V1_SCHEMA_ID, version: LESSON_V1_SCHEMA_VERSION };
    if (expectedState !== undefined) candidate.state = expectedState;
    const normalized = normalizeLessonV1(candidate, { now: this.#time() });
    // normalizeLessonV1's digest is calculated before and after lifecycle
    // defaults, but repeat it here so callers cannot smuggle a stale identity.
    normalized.contentDigest = lessonContentDigest(normalized);
    const result = validateLessonV1(normalized, { limits: { maxConditions: this.limits.maxConditionCount, maxLessonBytes: this.limits.maxLessonBytes }, now: Date.parse(this.#time()) });
    if (!result.ok) throw new LessonRegistryValidationError(result.errors);
    if (encoder.encode(canonicalJson(normalized)).byteLength > this.limits.maxLessonBytes) throw new LessonRegistryError("lesson_oversized", "lesson exceeds its configured byte bound");
    return normalized;
  }

  async *#streamEntries({ batchSize = this.limits.maxRebuildBatch } = {}) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > this.limits.maxRebuildBatch) throw new LessonRegistryError("rebuild_batch_invalid", "lesson registry rebuild batch is outside its bound");
    if (typeof this.#ledger.streamRecords === "function") {
      const iterable = await Promise.resolve(this.#ledger.streamRecords({ batchSize }));
      for await (const entry of iterable) yield entry;
      return;
    }
    if (typeof this.#ledger.iterateRecords === "function") {
      const iterable = await Promise.resolve(this.#ledger.iterateRecords({ batchSize }));
      for await (const entry of iterable) yield entry;
      return;
    }
    if (typeof this.#ledger.queryRecords === "function") {
      const iterable = await Promise.resolve(this.#ledger.queryRecords({ batchSize }));
      for await (const entry of iterable) yield entry;
      return;
    }
    if (typeof this.#ledger.listRecords !== "function") throw new LessonRegistryError("ledger_stream_unavailable", "ledger does not expose a bounded record stream");
    let cursor;
    let page = 0;
    for (;;) {
      const result = await this.#ledger.listRecords({ limit: batchSize, cursor });
      if (!result || !Array.isArray(result.records) || result.records.length > batchSize) throw new LessonRegistryError("ledger_page_invalid", "ledger returned an invalid bounded record page");
      for (const entry of result.records) yield entry;
      const next = result.nextCursor ?? result.cursor;
      if (!result.truncated) return;
      if (next === undefined || next === cursor || page++ > this.limits.maxQueryRecords) throw new LessonRegistryError("ledger_stream_truncated", "ledger cannot provide a complete bounded lesson stream");
      cursor = next;
    }
  }

  async #decodeEntry(entry) {
    if (!entry || typeof entry !== "object") return undefined;
    const record = entry.record;
    // Only a canonical Ticket Episode lesson event can enter the registry.
    // Inline payload shortcuts are deliberately not accepted: the artifact,
    // its content address, and the event identity must bind one another.
    if (record?.event?.kind !== "lesson") return undefined;
    const refs = Array.isArray(entry.artifacts) ? entry.artifacts : [];
    const reference = refs.find((candidate) => typeof candidate?.identity === "string" && candidate.identity.startsWith("lesson-v1-"));
    if (!reference || typeof this.#ledger.readArtifact !== "function") throw new LessonRegistryError("lesson_artifact_missing", "durable lesson event has no readable lesson artifact");
    if (!Number.isSafeInteger(reference.size) || reference.size < 0 || reference.size > this.limits.maxLessonBytes) throw new LessonRegistryError("lesson_oversized", "durable lesson artifact exceeds its configured byte bound");
    let bytes;
    try { bytes = await this.#ledger.readArtifact(reference, { maxBytes: this.limits.maxLessonBytes }); }
    catch { throw new LessonRegistryError("lesson_artifact_unreadable", "durable lesson artifact could not be read"); }
    if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) throw new LessonRegistryError("lesson_artifact_invalid", "durable lesson artifact is not byte data");
    if (bytes.byteLength > this.limits.maxLessonBytes) throw new LessonRegistryError("lesson_oversized", "durable lesson artifact exceeds its configured byte bound");
    let parsed;
    try {
      parsed = JSON.parse(decoder.decode(bytes));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    } catch { throw new LessonRegistryError("lesson_artifact_invalid", "durable lesson artifact is not canonical JSON"); }
    if (typeof parsed.id !== "string" || !Number.isSafeInteger(parsed.version) || typeof parsed.contentDigest !== "string") throw new LessonRegistryError("lesson_artifact_invalid", "durable lesson artifact lacks a bounded immutable identity");
    const canonicalBytes = encoder.encode(canonicalJson(parsed));
    if (!Number.isSafeInteger(reference.size) || reference.size !== bytes.byteLength || typeof reference.digest !== "string" || sha256(bytes) !== reference.digest || !Buffer.from(canonicalBytes).equals(Buffer.from(bytes))) throw new LessonRegistryError("lesson_artifact_integrity_failed", "durable lesson artifact content address or canonical bytes do not match");
    if (reference.identity !== artifactIdentity(parsed) || record.event.id !== eventIdentity(parsed) || record.episode?.id !== episodeIdentity(parsed) || record.repository?.revision !== parsed.provenance.repositoryRevision) throw new LessonRegistryError("lesson_artifact_binding_invalid", "durable lesson artifact is not bound to its lesson event identity and repository provenance");
    return parsed;
  }

  #checkCacheAdmission(lesson, maps = { latest: this.#latest, versions: this.#versions }) {
    const key = lessonKey(lesson), priorVersion = maps.versions.get(key), priorLesson = maps.latest.get(lesson.id);
    if (!priorVersion && maps.versions.size >= this.limits.maxStoredVersions) throw new LessonRegistryError("lesson_history_limit", "lesson registry history bound exceeded");
    if (active(lesson) && !active(priorLesson)) {
      let activeCount = 0;
      for (const candidate of maps.latest.values()) if (active(candidate)) activeCount += 1;
      if (activeCount >= this.limits.maxActiveLessons) throw new LessonRegistryError("active_lesson_limit", "lesson registry active lesson bound exceeded");
    }
  }

  #remember(lesson, maps = { latest: this.#latest, versions: this.#versions, sequences: this.#sequences }) {
    const key = lessonKey(lesson);
    const prior = maps.versions.get(key);
    if (prior && prior.contentDigest !== lesson.contentDigest) throw new LessonRegistryConflictError("lesson_version_conflict", "one lesson version has multiple immutable content identities", { lessonId: lesson.id, version: lesson.version });
    this.#checkCacheAdmission(lesson, maps);
    if (!prior) maps.versions.set(key, { contentDigest: lesson.contentDigest, states: [] });
    const version = maps.versions.get(key);
    if (!version.states.some((stateEntry) => stateEntry.state === lesson.state && stateEntry.updatedAt === lesson.updatedAt && stateEntry.contentDigest === lesson.contentDigest)) version.states.push({ state: lesson.state, updatedAt: lesson.updatedAt ?? lesson.createdAt, contentDigest: lesson.contentDigest });
    maps.latest.set(lesson.id, clone(lesson));
  }

  #validateDurableLifecycle(lesson, record, prior, admission, entry) {
    if (!this.#admissionAuthority || !verifyLessonAdmission(entry, admission, this.#admissionAuthority.publicKey)) throw new LessonRegistryError("lesson_admission_invalid", "durable lesson event lacks a valid registry authority binding");
    if (record?.event?.kind !== "lesson" || record.project?.id !== this.projectId || record.repository?.id !== this.repositoryId || record.ticket?.system !== this.ticket.system || record.ticket?.id !== this.ticket.id || record.producer?.id !== "lesson-registry" || record.producer?.kind !== "system" || record.state !== "quarantined" || record.evidence?.class !== "caller_claim" || record.evidence?.authority?.level !== "untrusted" || record.coverage?.status !== "partial") throw new LessonRegistryError("lesson_event_untrusted", "durable lesson event is not an authenticated registry admission");
    const history = lesson.stateHistory;
    if (!prior || lesson.version > prior.version) {
      if (lesson.state !== "proposed" || history.length !== 0 || lesson.evaluation !== undefined) throw new LessonRegistryError("lesson_lifecycle_invalid", "durable lesson history must begin with an unevaluated proposal", { lessonId: lesson.id, version: lesson.version });
    } else {
      if (lesson.version < prior.version) throw new LessonRegistryError("lesson_lifecycle_invalid", "durable lesson history regressed to an older version", { lessonId: lesson.id, version: lesson.version });
      if (lesson.contentDigest !== prior.contentDigest) throw new LessonRegistryConflictError("lesson_version_conflict", "durable lesson history contains multiple immutable content identities", { lessonId: lesson.id, version: lesson.version });
      const transition = history.at(-1);
      if (history.length !== prior.stateHistory.length + 1 || !transition || transition.from !== prior.state || transition.to !== lesson.state || !validateLessonTransition(transition.from, transition.to).ok) throw new LessonRegistryError("lesson_lifecycle_invalid", "durable lesson history does not contain the admitted prior transition", { lessonId: lesson.id, version: lesson.version });
    }
    if (lesson.state === "evaluated" && !lesson.evaluation) throw new LessonRegistryError("lesson_lifecycle_invalid", "evaluated lessons must contain a durable evaluation");
    if (lesson.state === "promoted" && prior?.state === "evaluated" && !lesson.evaluation) throw new LessonRegistryError("lesson_lifecycle_invalid", "normal promoted lessons must retain their durable evaluation");
    if (lesson.state === "promoted" && prior?.state === "proposed") {
      if (lesson.catastrophicSafetyException === undefined) throw new LessonRegistryError("lesson_lifecycle_invalid", "direct promotion must carry the catastrophic safety exception");
      if (!this.#authorizedHumanIdentities.has(lesson.catastrophicSafetyException.approvedBy)) throw new LessonRegistryError("catastrophic_exception_approver_unauthorized", "durable catastrophic promotion lacks an authorized human approver");
    }
  }

  async *#streamValidatedLessons({ batchSize = this.limits.maxRebuildBatch } = {}) {
    const durableLatest = new Map(), nextSequences = new Map();
    for await (const entry of this.#streamEntries({ batchSize })) {
      const lesson = await this.#decodeEntry(entry);
      const record = entry?.record;
      if (typeof record?.episode?.id === "string") {
        if (!Number.isSafeInteger(record.sequence)) throw new LessonRegistryError("lesson_lifecycle_invalid", "durable lesson event sequence is invalid");
        const expected = nextSequences.get(record.episode.id) ?? 0;
        if (record.sequence !== expected) throw new LessonRegistryError("lesson_lifecycle_invalid", "durable lesson event sequence is not contiguous");
        nextSequences.set(record.episode.id, expected + 1);
      }
      if (!lesson) continue;
      const prepared = this.#prepare(lesson);
      this.#validateDurableLifecycle(prepared, record, durableLatest.get(prepared.id), entry?.lessonAdmission, entry);
      durableLatest.set(prepared.id, prepared);
      yield { lesson: prepared, record, entry };
    }
  }

  async rebuild({ batchSize = this.limits.maxRebuildBatch } = {}) {
    this.#assertOpen();
    const run = this.#rebuildPromise.catch(() => {}).then(async () => {
      const latest = new Map(), versions = new Map(), sequences = new Map();
      try {
        for await (const { lesson, record: eventRecord } of this.#streamValidatedLessons({ batchSize })) {
          if (eventRecord?.episode?.id && Number.isSafeInteger(eventRecord.sequence)) sequences.set(eventRecord.episode.id, Math.max(sequences.get(eventRecord.episode.id) ?? -1, eventRecord.sequence + 1));
          this.#remember(lesson, { latest, versions, sequences });
        }
      } catch (error) {
        if (error instanceof LessonRegistryError) throw error;
        throw new LessonRegistryError("rebuild_failed", "lesson registry rebuild failed closed", { causeCode: compactErrorCode(error) });
      }
      this.#latest = latest;
      this.#versions = versions;
      this.#sequences = sequences;
      return { lessons: [...latest.values()].map(clone), versions: versions.size, count: latest.size };
    });
    this.#rebuildPromise = run.then(() => {}, () => {});
    return run;
  }

  #resolve(input, version) {
    if (typeof input === "string") {
      const lesson = this.#latest.get(input);
      if (!lesson || (version !== undefined && lesson.version !== version)) throw new LessonRegistryError("lesson_not_found", "lesson is not present in the registry", { lessonId: input });
      return clone(lesson);
    }
    if (!input || typeof input !== "object" || typeof input.id !== "string") throw new LessonRegistryError("lesson_not_found", "lesson identity is required");
    const current = this.#latest.get(input.id);
    if (!current || input.version !== current.version || (version !== undefined && current.version !== version)) throw new LessonRegistryError("lesson_not_found", "lesson is not present in the registry", { lessonId: input.id });
    if (input.contentDigest !== current.contentDigest) throw new LessonRegistryConflictError("lesson_version_conflict", "transition must use the admitted lesson content identity", { lessonId: input.id, version: input.version });
    return clone(current);
  }

  get(id, version) {
    this.#assertOpen();
    const lesson = this.#latest.get(id);
    if (!lesson || (version !== undefined && lesson.version !== version)) return undefined;
    return clone(lesson);
  }
  getLesson(id, version) { return this.get(id, version); }
  has(id, version) { return this.get(id, version) !== undefined; }
  list({ state, limit = this.limits.maxQueryRecords, includeHistory = false, historyLimit = limit, maxBytes = this.limits.maxQueryBytes } = {}) {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > this.limits.maxQueryRecords || !Number.isSafeInteger(historyLimit) || historyLimit < 0 || historyLimit > this.limits.maxQueryRecords || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.limits.maxQueryBytes) throw new LessonRegistryError("query_invalid", "lesson query limit is outside its bound");
    const lessons = [], lessonIterator = this.#latest.values();
    let lessonTruncated = false;
    for (const lesson of lessonIterator) {
      if (state !== undefined && lesson.state !== state) continue;
      if (lessons.length >= limit) { lessonTruncated = true; break; }
      lessons.push(clone(lesson));
    }
    if (!includeHistory) return { lessons, truncated: lessonTruncated };
    const history = [];
    let historyBytes = 0, historyTruncated = false;
    for (const [key, value] of this.#versions) {
      if (history.length >= historyLimit) { historyTruncated = true; break; }
      const item = { key, contentDigest: value.contentDigest, states: clone(value.states) }, bytes = encoder.encode(canonicalJson(item)).byteLength;
      if (historyBytes + bytes > maxBytes) { historyTruncated = true; break; }
      history.push(item); historyBytes += bytes;
    }
    return { lessons, truncated: lessonTruncated, history, historyTruncated, historyBytes };
  }
  listLessons(options = {}) { return this.list(options); }

  async *streamLessons({ state, batchSize = this.limits.maxRebuildBatch } = {}) {
    this.#assertOpen();
    const seen = new Set();
    for await (const { lesson: prepared } of this.#streamValidatedLessons({ batchSize })) {
      const key = contentKey(prepared) + `\u0000${prepared.state}`;
      if (seen.has(key) || (state !== undefined && prepared.state !== state)) continue;
      seen.add(key);
      yield clone(prepared);
    }
  }

  async #persist(lesson) {
    this.#assertOpen();
    const episodeId = episodeIdentity(lesson), sequence = this.#sequences.get(episodeId) ?? 0;
    const eventId = eventIdentity(lesson);
    const record = {
      schema: { id: "https://pi-sampler.dev/contracts/ticket-episode/v1", version: "1.0.0" },
      project: { id: this.projectId },
      repository: { id: this.repositoryId, revision: lesson.provenance.repositoryRevision },
      ticket: this.ticket,
      episode: { id: episodeId },
      attempt: { id: `lesson-attempt-${sha256(`${lesson.id}\u0000${lesson.version}`).slice(0, 48)}` },
      session: { id: `lesson-session-${sha256(`${lesson.id}\u0000${lesson.version}`).slice(0, 48)}` },
      agentRun: { agentId: "lesson-registry", runId: `lesson-run-${sha256(eventId).slice(0, 48)}` },
      event: { id: eventId, kind: "lesson" },
      producer: { id: "lesson-registry", kind: "system" },
      occurredAt: lesson.updatedAt ?? lesson.createdAt,
      sequence,
      evidence: { class: "caller_claim", authority: { level: "untrusted" } },
      state: "quarantined",
      coverage: { status: "partial", expectedEventCount: 1, observedEventCount: 0, missingEventIds: [`lesson-source-${sha256(lesson.contentDigest).slice(0, 32)}`] },
    };
    const bytes = encoder.encode(canonicalJson(lesson));
    const artifact = { bytes, metadata: { identity: artifactIdentity(lesson), evidenceClass: "caller_claim", coverage: "partial", provenance: canonicalJson({ lessonId: lesson.id, version: lesson.version, state: lesson.state }), sensitivity: "internal" } };
    if (!this.#admissionAuthority || typeof this.#ledger.appendLesson !== "function") throw new LessonRegistryError("lesson_admission_api_unavailable", "lesson persistence requires the protected registry admission API");
    const admissionSigner = (envelope) => signedLessonAdmission(this.#admissionAuthority, envelope);
    try {
      return { result: await this.#ledger.appendLesson(clone(lesson), { record: clone(record), artifact: clone(artifact), admissionSigner }), record };
    } catch (error) {
      if (error instanceof LessonRegistryError) throw error;
      throw new LessonRegistryError("persistence_failed", "lesson registry persistence failed closed", { causeCode: compactErrorCode(error) });
    }
  }

  #persistAndRemember(lesson, admission = "transition") {
    const run = this.#admissions.catch(() => {}).then(() => this.#persistAndRememberExclusive(lesson, admission));
    this.#admissions = run.then(() => {}, () => {});
    return run;
  }

  async #persistAndRememberExclusive(lesson, admission) {
    // Every durable path must reject an immutable version/content conflict
    // before publication. Transition callers are resolved from the admitted
    // cache, but this remains a defense-in-depth check for future paths.
    const existing = this.#versions.get(lessonKey(lesson));
    if (existing && existing.contentDigest !== lesson.contentDigest) throw new LessonRegistryConflictError("lesson_version_conflict", "lesson version is already bound to different content", { lessonId: lesson.id, version: lesson.version });
    // Proposal identity and version checks belong inside the serialized
    // admission section. Checking the cache before queueing lets concurrent
    // proposals publish conflicting durable content before the loser notices.
    if (admission === "proposal") {
      const existing = this.#versions.get(lessonKey(lesson));
      if (existing) {
        if (existing.contentDigest !== lesson.contentDigest) throw new LessonRegistryConflictError("lesson_version_conflict", "lesson version is already bound to different content", { lessonId: lesson.id, version: lesson.version });
        const current = this.#latest.get(lesson.id);
        if (current?.version === lesson.version) return { status: "idempotent", lesson: clone(current) };
        throw new LessonRegistryConflictError("lesson_version_conflict", "lesson version is already present", { lessonId: lesson.id, version: lesson.version });
      }
      const highest = [...this.#versions.keys()].filter((key) => key.startsWith(`${lesson.id}\u0000`)).map((key) => Number(key.split("\u0000").at(-1))).filter(Number.isSafeInteger);
      if (highest.length && lesson.version <= Math.max(...highest)) throw new LessonRegistryConflictError("lesson_version_order", "new lesson content must increase its version", { lessonId: lesson.id, version: lesson.version });
    }
    // Preflight before the first durable write. A cache-limit rejection must
    // never leave a lesson event that rebuild cannot represent.
    this.#checkCacheAdmission(lesson);
    const snapshot = { latest: this.#latest, versions: this.#versions, sequences: this.#sequences };
    try {
      const persisted = await this.#persist(lesson);
      const latest = new Map(this.#latest), versions = new Map([...this.#versions].map(([key, value]) => [key, { contentDigest: value.contentDigest, states: clone(value.states) }])), sequences = new Map(this.#sequences);
      this.#remember(lesson, { latest, versions, sequences });
      const episodeId = persisted.record.episode.id;
      sequences.set(episodeId, (sequences.get(episodeId) ?? persisted.record.sequence) + 1);
      this.#latest = latest; this.#versions = versions; this.#sequences = sequences;
      return { status: persisted.result?.status ?? "committed", lesson: clone(lesson), record: clone(persisted.record), result: clone(persisted.result ?? {}) };
    } catch (error) {
      // No cache map is changed until durable publication succeeds. Restore the
      // maps anyway so a future implementation hook cannot leak partial state.
      this.#latest = snapshot.latest; this.#versions = snapshot.versions; this.#sequences = snapshot.sequences;
      if (error instanceof LessonRegistryError) throw error;
      throw new LessonRegistryError("transition_rolled_back", "lesson registry transition rolled back");
    }
  }

  async propose(input) {
    this.#assertOpen();
    const lesson = this.#prepare(input, "proposed");
    return this.#persistAndRemember(lesson, "proposal");
  }
  proposeLesson(input) { return this.propose(input); }

  async transition(input, targetState, metadata = {}) {
    this.#assertOpen();
    if (!LESSON_LIFECYCLE_STATES.includes(targetState)) throw new LessonRegistryTransitionError("state_invalid", "unknown lesson lifecycle state");
    const current = this.#resolve(input, metadata.version);
    if (current.state === targetState) return { status: "idempotent", lesson: current };
    const allowed = validateLessonTransition(current.state, targetState);
    if (!allowed.ok) throw new LessonRegistryTransitionError("state_transition_invalid", "lesson lifecycle transition is not allowed", { from: current.state, to: targetState });
    const changedAt = this.#time();
    const next = clone(current);
    next.state = targetState;
    next.updatedAt = changedAt;
    next.stateHistory = [...(next.stateHistory ?? []), { from: current.state, to: targetState, changedAt, actorId: metadata.actorId ?? "lesson-registry", ...(metadata.reason ? { reason: String(metadata.reason).slice(0, 4096) } : {}), ...(metadata.decisionId ? { decisionId: metadata.decisionId } : {}) }];
    if (targetState === "rejected") next.rejection = { reason: String(metadata.reason ?? "rejected by policy").slice(0, 4096), rejectedAt: changedAt, rejectedBy: metadata.actorId ?? "lesson-registry" };
    if (targetState === "retired") next.retirement = { reason: String(metadata.reason ?? "retired by policy").slice(0, 4096), retiredAt: changedAt, retiredBy: metadata.actorId ?? "lesson-registry" };
    if (targetState === "superseded" && metadata.supersededBy) next.supersededBy = clone(metadata.supersededBy);
    if (targetState === "evaluated") {
      if (!metadata.evaluation || typeof metadata.evaluation !== "object") throw new LessonRegistryTransitionError("evaluation_required", "evaluating a lesson requires an evaluation identity");
      next.evaluation = { identity: metadata.evaluation.identity, evaluatedAt: metadata.evaluation.evaluatedAt ?? changedAt, ...(metadata.evaluation.score === undefined ? {} : { score: metadata.evaluation.score }), ...(metadata.evaluation.notes === undefined ? {} : { notes: String(metadata.evaluation.notes).slice(0, 4096) }) };
    }
    if (targetState === "promoted") {
      if (current.state === "proposed" && next.catastrophicSafetyException === undefined) throw new LessonRegistryPromotionError("evaluation_required", "normal promotion requires an evaluated lesson");
      await this.#guardPromotion(next);
    }
    next.contentDigest = lessonContentDigest(next);
    const result = validateLessonV1(next, { now: Date.parse(changedAt) });
    if (!result.ok) throw new LessonRegistryTransitionError("transition_invalid", "lesson lifecycle transition failed closed validation", { codes: compactErrors(result.errors).map((error) => error.code) });
    return this.#persistAndRemember(next);
  }
  evaluate(input, evaluation = {}) { return this.transition(input, "evaluated", { evaluation, actorId: evaluation.actorId ?? "lesson-evaluator" }); }
  monitor(input, metadata = {}) { return this.transition(input, "monitored", metadata); }
  revert(input, metadata = {}) { return this.transition(input, "reverted", metadata); }
  retire(input, metadata = {}) { return this.transition(input, "retired", metadata); }
  reject(input, metadata = {}) { return this.transition(input, "rejected", metadata); }
  supersede(input, successor, metadata = {}) { return this.transition(input, "superseded", { ...metadata, supersededBy: successor && typeof successor === "object" ? { lessonId: successor.id, version: successor.version } : { lessonId: successor, version: metadata.version ?? 1 } }); }

  async #boundedCurrentLessons() {
    const latest = new Map();
    for await (const lesson of this.streamLessons({ batchSize: this.limits.maxRebuildBatch })) {
      const key = lessonKey(lesson);
      const prior = latest.get(key);
      if (!prior || (lesson.updatedAt ?? lesson.createdAt) >= (prior.updatedAt ?? prior.createdAt)) latest.set(key, lesson);
    }
    const byId = new Map();
    for (const lesson of latest.values()) {
      const prior = byId.get(lesson.id);
      if (!prior || lesson.version > prior.version || (lesson.version === prior.version && (lesson.updatedAt ?? lesson.createdAt) >= (prior.updatedAt ?? prior.createdAt))) byId.set(lesson.id, lesson);
    }
    return [...byId.values()];
  }

  async detectConflicts(input) {
    this.#assertOpen();
    const lesson = this.#prepare(input);
    const conflicts = [];
    try {
      for (const candidate of await this.#boundedCurrentLessons()) {
        if (!active(candidate) || candidate.id === lesson.id) continue;
        const overlap = applicabilityOverlap(lesson, candidate);
        if (!overlap.overlaps || !behaviorConflict(lesson, candidate)) continue;
        conflicts.push(safeLessonSummary(candidate, overlap.compared ? "overlapping_contradictory_behavior" : "contradictory_behavior", true));
      }
      return conflicts;
    } catch (error) {
      if (error instanceof LessonRegistryError && error.code === "conflict_detection_failed") throw error;
      throw new LessonRegistryError("conflict_detection_failed", "lesson conflict detection failed closed", { causeCode: compactErrorCode(error) });
    }
  }

  async detectOverlaps(input) {
    this.#assertOpen();
    const lesson = this.#prepare(input);
    const overlaps = [];
    try {
      for (const candidate of await this.#boundedCurrentLessons()) {
        if (!active(candidate) || candidate.id === lesson.id) continue;
        const overlap = applicabilityOverlap(lesson, candidate);
        if (overlap.overlaps) overlaps.push(safeLessonSummary(candidate, behaviorConflict(lesson, candidate) ? "overlapping_contradictory_behavior" : "overlapping_applicability", behaviorConflict(lesson, candidate)));
      }
      return overlaps;
    } catch (error) {
      throw new LessonRegistryError("overlap_detection_failed", "lesson overlap detection failed closed", { causeCode: compactErrorCode(error) });
    }
  }

  detectStaleness(lesson, { now, currentRepositoryRevision = this.currentRepositoryRevision, currentEvaluatorIdentity = this.currentEvaluatorIdentity, maxAgeMs = this.limits.maxAgeMs, maxFutureSkewMs = this.limits.maxFutureSkewMs } = {}) {
    const candidate = this.#prepare(lesson);
    const errors = [];
    const clock = now === undefined ? Date.now() : (typeof now === "function" ? now() : now);
    if (!Number.isFinite(clock)) errors.push("clock_invalid");
    if (currentRepositoryRevision && candidate.provenance.repositoryRevision !== currentRepositoryRevision) errors.push("repository_revision_stale");
    const evaluatorIdentity = candidate.evaluator.identityDigest ?? `${candidate.evaluator.id}@${candidate.evaluator.version}`;
    if (currentEvaluatorIdentity && evaluatorIdentity !== currentEvaluatorIdentity && candidate.evaluator.id !== currentEvaluatorIdentity) errors.push("evaluator_identity_stale");
    const created = Date.parse(candidate.createdAt);
    if (Number.isFinite(clock) && clock - created > maxAgeMs) errors.push("lesson_stale");
    if (Number.isFinite(clock) && created > clock + maxFutureSkewMs) errors.push("lesson_future_dated");
    return { stale: errors.length > 0, errors, lessonId: candidate.id, version: candidate.version };
  }
  isStale(lesson, options = {}) { return this.detectStaleness(lesson, options).stale; }
  async findStale(options = {}) {
    const result = [];
    for await (const lesson of this.streamLessons({ batchSize: options.batchSize ?? this.limits.maxRebuildBatch })) if (active(lesson) && this.detectStaleness(lesson, options).stale) result.push(safeLessonSummary(lesson, "stale_evidence"));
    return result;
  }

  async #guardPromotion(lesson) {
    const structural = validateLessonV1(lesson, { now: Date.parse(this.#time()) });
    if (!structural.ok) throw new LessonRegistryPromotionError("lesson_invalid", "lesson cannot be promoted because validation failed", { codes: compactErrors(structural.errors).map((error) => error.code) });
    if (lesson.evidence.length === 0) throw new LessonRegistryPromotionError("evidence_required", "promotion requires evidence");
    const tickets = sourceTickets(lesson), episodes = sourceEpisodes(lesson), events = sourceEvents(lesson);
    const emergency = lesson.catastrophicSafetyException;
    if (emergency !== undefined) {
      const exception = validateCatastrophicSafetyException(emergency, lesson);
      if (!exception.ok) throw new LessonRegistryPromotionError("catastrophic_exception_malformed", "catastrophic safety exception was rejected fail closed", { codes: compactErrors(exception.errors).map((error) => error.code) });
      if (tickets.size !== 1 || episodes.size !== 1 || events.size !== 1 || lesson.behavior.kind !== "avoid" || lesson.applicability.conditions.length > 4) throw new LessonRegistryPromotionError("catastrophic_exception_scope_invalid", "catastrophic safety exception is broader than the narrow emergency policy");
      if (!this.#authorizedHumanIdentities.has(emergency.approvedBy)) throw new LessonRegistryPromotionError("catastrophic_exception_approver_unauthorized", "catastrophic safety exception requires an authorized human approver");
    } else if (tickets.size < 2) {
      throw new LessonRegistryPromotionError("evidence_ticket_breadth_insufficient", "promotion requires evidence from at least two distinct tickets");
    }
    const stale = this.detectStaleness(lesson);
    if (stale.stale) throw new LessonRegistryPromotionError("evidence_stale", "promotion evidence is stale", { errors: stale.errors });
    let conflicts;
    try { conflicts = await this.detectConflicts(lesson); }
    catch (error) { throw new LessonRegistryPromotionError("conflict_detection_failed", "promotion failed closed because conflict detection was unavailable", { causeCode: compactErrorCode(error) }); }
    if (!Array.isArray(conflicts)) throw new LessonRegistryPromotionError("conflict_detection_failed", "promotion failed closed because conflict detection returned no bounded result");
    if (conflicts.length > 0) throw new LessonRegistryPromotionError("conflict_detected", "promotion requires explicit supersession or rejection for conflicting lessons", { conflicts: conflicts.map((entry) => `${entry.lessonId}:${entry.version}`) });
    let overlaps;
    try { overlaps = await this.detectOverlaps(lesson); }
    catch (error) { throw new LessonRegistryPromotionError("overlap_detection_failed", "promotion failed closed because overlap detection was unavailable", { causeCode: compactErrorCode(error) }); }
    if (!Array.isArray(overlaps)) throw new LessonRegistryPromotionError("overlap_detection_failed", "promotion failed closed because overlap detection returned no bounded result");
    if (overlaps.some((entry) => entry.conflict === true)) throw new LessonRegistryPromotionError("conflict_detected", "promotion requires explicit handling of contradictory overlap");
    const promotedCount = [...this.#latest.values()].filter((entry) => ["promoted", "monitored"].includes(entry.state) && entry.id !== lesson.id).length;
    if (promotedCount >= this.limits.maxActiveLessons) throw new LessonRegistryPromotionError("rule_accumulation_limit", "promotion would exceed the active lesson bound");
  }

  async promote(input, options = {}) {
    try { return await this.transition(input, "promoted", options); }
    catch (error) {
      if (error instanceof LessonRegistryValidationError) {
        const codes = error.errors.map((entry) => entry.code);
        if (codes.includes("evidence_required") || error.errors.some((entry) => entry.code === "schema_invalid" && entry.path.startsWith("/evidence"))) throw new LessonRegistryPromotionError("evidence_required", "promotion requires at least one valid evidence citation", { codes });
        if (codes.some((code) => code.startsWith("catastrophic_exception"))) throw new LessonRegistryPromotionError("catastrophic_exception_malformed", "catastrophic safety exception was rejected fail closed", { codes });
      }
      throw error;
    }
  }

  async analyzeAccumulation({ maxActiveLessons = this.limits.maxActiveLessons } = {}) {
    let activeCount = 0, terminalCount = 0;
    const byKind = Object.fromEntries(LESSON_BEHAVIOR_KINDS.map((kind) => [kind, 0]));
    const byRisk = Object.fromEntries(LESSON_RISK_LEVELS.map((level) => [level, 0]));
    for (const lesson of this.#latest.values()) {
      if (["promoted", "monitored"].includes(lesson.state)) activeCount += 1;
      if (terminal(lesson)) terminalCount += 1;
      if (active(lesson)) { byKind[lesson.behavior.kind] = (byKind[lesson.behavior.kind] ?? 0) + 1; byRisk[lesson.risk.level] = (byRisk[lesson.risk.level] ?? 0) + 1; }
    }
    return { activeCount, maxActiveLessons, exceeded: activeCount > maxActiveLessons, byKind, byRisk, terminalCount };
  }
  async stats(options = {}) { return this.analyzeAccumulation(options); }
}

export const LessonRegistryStateError = LessonRegistryTransitionError;
export const LessonRegistryConflict = LessonRegistryConflictError;
