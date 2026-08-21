import { createHash } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";
import { EpisodeEvolutionLedger, LedgerConflictError, LedgerError, LedgerLimitError } from "./episode-evolution-ledger.mjs";
import {
  ANNOTATION_V1_SCHEMA_ID,
  ANNOTATION_V1_SCHEMA_VERSION,
  DEFAULT_ANNOTATION_LIMITS,
  annotationContentDigest,
  canonicalJson,
  isAnnotationTombstone,
  migrateAnnotationV1,
  normalizeAnnotationV1,
  validateAnnotationV1,
} from "../contracts/annotation-v1.mjs";
import { TICKET_EPISODE_V1_SCHEMA_ID, TICKET_EPISODE_V1_SCHEMA_VERSION } from "../contracts/ticket-episode-v1.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const clone = (value) => structuredClone(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export const ANNOTATION_LEDGER_FORMAT_VERSION = 1;
export const DEFAULT_ANNOTATION_LEDGER_LIMITS = Object.freeze({
  ...DEFAULT_ANNOTATION_LIMITS,
  maxArtifactBytes: DEFAULT_ANNOTATION_LIMITS.maxAnnotationBytes,
});
export { ANNOTATION_V1_SCHEMA_ID, ANNOTATION_V1_SCHEMA_VERSION };

function compactDetails(details = {}) {
  return Object.fromEntries(Object.entries(details).filter(([key, value]) => {
    if (["annotation", "payload", "record", "entry", "cause", "error"].includes(key)) return false;
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || (Array.isArray(value) && value.length <= 32 && value.every((item) => typeof item === "string"));
  }));
}

export class AnnotationLedgerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AnnotationLedgerError";
    this.code = code;
    this.details = compactDetails(details);
  }
}
export class AnnotationLedgerValidationError extends AnnotationLedgerError {
  constructor(errors) {
    super("annotation_invalid", "annotation payload failed closed validation", { codes: errors.map((error) => error.code).slice(0, 32) });
    this.name = "AnnotationLedgerValidationError";
    this.errors = errors.map(({ code, message, path }) => ({ code, message, path }));
  }
}
export class AnnotationLedgerConflictError extends AnnotationLedgerError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = "AnnotationLedgerConflictError";
  }
}
export class AnnotationLedgerLimitError extends AnnotationLedgerError {
  constructor(limit, actual, maximum) {
    super("limit_exceeded", `${limit} exceeds its configured bound`, { limit, actual, maximum });
    this.name = "AnnotationLedgerLimitError";
  }
}

const errorCode = (error) => typeof error?.code === "string" && /^[a-z0-9_:-]{1,96}$/.test(error.code) ? error.code : "storage_error";
const ensureIdentifier = (value, name) => {
  if (typeof value !== "string" || !identifierPattern.test(value)) throw new AnnotationLedgerError("identity_invalid", `${name} is invalid`);
  return value;
};
const ensureRevision = (value) => {
  if (typeof value !== "string" || !revisionPattern.test(value)) throw new AnnotationLedgerError("repository_revision_invalid", "repository revision is invalid");
  return value;
};
const annotationEpisodeId = (id) => `annotation-episode-${sha256(id)}`;
const annotationArtifactIdentity = (annotation) => `annotation-v1-${sha256(`${annotation.id}\u0000${annotation.revision.id}\u0000${annotation.contentDigest}`)}`;
const annotationSourceId = (annotation) => `annotation-source-${sha256(annotation.contentDigest).slice(0, 32)}`;
const annotationAttemptId = (id) => `annotation-attempt-${sha256(id).slice(0, 48)}`;
const annotationSessionId = (id) => `annotation-session-${sha256(id).slice(0, 48)}`;
const annotationRunId = (id) => `annotation-run-${sha256(id).slice(0, 48)}`;
const cursorEncode = (offset) => Buffer.from(JSON.stringify({ version: 1, offset })).toString("base64url");
const cursorDecode = (cursor) => {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (typeof cursor !== "string" || cursor.length > 256) throw new AnnotationLedgerError("cursor_invalid", "annotation cursor is invalid");
  let value;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new AnnotationLedgerError("cursor_invalid", "annotation cursor is invalid"); }
  if (value?.version !== 1 || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new AnnotationLedgerError("cursor_invalid", "annotation cursor is invalid");
  return value.offset;
};

function configuredLimits(limits = {}) {
  const result = { ...DEFAULT_ANNOTATION_LEDGER_LIMITS, ...limits };
  for (const [key, value] of Object.entries(result)) if (!Number.isSafeInteger(value) || value < 1) throw new AnnotationLedgerError("invalid_limit", `invalid annotation limit ${key}`);
  return Object.freeze(result);
}

function revisionKey(annotation) { return `${annotation.id}\u0000${annotation.revision.id}`; }
function expectedRevisionValue(value) {
  if (value === undefined || value === null) return undefined;
  if (Number.isSafeInteger(value) && value >= 1) return { number: value };
  if (typeof value === "string") return digestPattern.test(value) ? { digest: value } : { id: value };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const result = {
      ...(Number.isSafeInteger(value.number) ? { number: value.number } : {}),
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      ...(typeof value.digest === "string" ? { digest: value.digest } : {}),
      ...(typeof value.contentDigest === "string" ? { digest: value.contentDigest } : {}),
    };
    if (Object.keys(result).length === 0) throw new AnnotationLedgerError("expected_revision_invalid", "expected revision is invalid");
    return result;
  }
  throw new AnnotationLedgerError("expected_revision_invalid", "expected revision is invalid");
}

function ticketRecord(annotation, { projectId, repositoryId, repositoryRevision, ticket }) {
  const episode = annotationEpisodeId(annotation.id);
  return {
    schema: { id: TICKET_EPISODE_V1_SCHEMA_ID, version: TICKET_EPISODE_V1_SCHEMA_VERSION },
    project: { id: projectId },
    repository: { id: repositoryId, revision: repositoryRevision },
    ticket,
    episode: { id: episode },
    attempt: { id: annotationAttemptId(annotation.id) },
    session: { id: annotationSessionId(annotation.id) },
    agentRun: { agentId: "annotation-ledger", runId: annotationRunId(annotation.id) },
    event: { id: annotation.revision.id, kind: "annotation" },
    producer: { id: annotation.author.id, kind: "human" },
    occurredAt: annotation.createdAt,
    sequence: annotation.revision.number - 1,
    evidence: { class: "human_annotation", authority: { level: "untrusted" } },
    state: "partial",
    coverage: { status: "partial", expectedEventCount: 1, observedEventCount: 0, missingEventIds: [annotationSourceId(annotation)] },
  };
}

function artifactMetadata(annotation) {
  return {
    identity: annotationArtifactIdentity(annotation),
    evidenceClass: "human_annotation",
    coverage: "partial",
    provenance: canonicalJson({ annotationId: annotation.id, revisionId: annotation.revision.id, revisionNumber: annotation.revision.number }),
    sensitivity: annotation.sensitivity,
  };
}

function sortedByRevision(items) {
  return [...items].sort((left, right) => left.annotation.revision.number - right.annotation.revision.number || left.annotation.revision.id.localeCompare(right.annotation.revision.id));
}

/**
 * Durable, bounded annotation facade over EpisodeEvolutionLedger. One
 * annotation identity owns one Ticket Episode and each immutable revision is a
 * human_annotation event plus one content-addressed artifact. The lower ledger
 * supplies fsync, writer locking, batch publication, backup, restore, and its
 * own version migration; this facade owns annotation semantics and projections.
 */
export class AnnotationLedger {
  static async open(options = {}) {
    let ledger = options.ledger;
    let ownsLedger = false;
    if (!ledger) {
      if (typeof options.root !== "string" || options.root.length === 0) throw new AnnotationLedgerError("root_required", "annotation ledger root is required");
      const ledgerOptions = options.ledgerOptions ?? {};
      ledger = await EpisodeEvolutionLedger.open({
        ...ledgerOptions,
        root: options.root,
        limits: options.ledgerLimits ?? ledgerOptions.limits,
        faultInjector: options.faultInjector ?? ledgerOptions.faultInjector,
      });
      ownsLedger = true;
    }
    const service = new AnnotationLedger({ ...options, ledger });
    try {
      if (typeof ledger.verifyIntegrity === "function") {
        const integrity = await ledger.verifyIntegrity();
        if (integrity?.ok !== true) throw new AnnotationLedgerError("underlying_integrity_failed", "underlying ledger integrity did not verify", { findingCount: integrity.findings?.length ?? 0, quarantineCount: integrity.quarantines?.length ?? 0 });
      }
      await service.rebuild();
      return service;
    } catch (error) {
      if (ownsLedger) await ledger.close().catch(() => {});
      if (error instanceof AnnotationLedgerError) throw error;
      throw new AnnotationLedgerError("rebuild_failed", "annotation ledger rebuild failed closed", { causeCode: errorCode(error) });
    }
  }

  static async restore(options = {}) {
    if (typeof options.backupPath !== "string" || typeof options.root !== "string") throw new AnnotationLedgerError("restore_invalid", "backupPath and root are required");
    let ledger;
    try {
      ledger = await EpisodeEvolutionLedger.restore({
        backupPath: options.backupPath,
        root: options.root,
        limits: options.ledgerLimits ?? options.ledgerOptions?.limits,
      });
      return await AnnotationLedger.open({ ...options, ledger });
    } catch (error) {
      await ledger?.close().catch(() => {});
      if (error instanceof AnnotationLedgerError) throw error;
      throw new AnnotationLedgerError("restore_failed", "annotation ledger restore failed closed", { causeCode: errorCode(error) });
    }
  }

  #ledger;
  #heads = new Map();
  #history = new Map();
  #admissions = Promise.resolve();

  constructor({ ledger, projectId = "pi-sampler", repositoryId = "github.com/Zkrausman/pi-sampler", repositoryRevision = "0".repeat(40), ticket = { system: "annotation-ledger", id: "ANNOTATION-V1" }, now = Date.now, limits = {} } = {}) {
    if (!ledger || typeof ledger !== "object") throw new AnnotationLedgerError("ledger_required", "an EpisodeEvolutionLedger facade is required");
    ensureIdentifier(projectId, "project identity");
    ensureIdentifier(repositoryId, "repository identity");
    ensureRevision(repositoryRevision);
    if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) throw new AnnotationLedgerError("ledger_identity_invalid", "annotation ticket identity is invalid");
    ensureIdentifier(ticket.system, "ticket system");
    ensureIdentifier(ticket.id, "ticket identity");
    this.#ledger = ledger;
    this.projectId = projectId;
    this.repositoryId = repositoryId;
    this.repositoryRevision = repositoryRevision;
    this.ticket = Object.freeze({ system: ticket.system, id: ticket.id });
    this.now = now;
    this.limits = configuredLimits(limits);
    this.closed = false;
  }

  get ledger() { return this.#ledger; }
  get formatVersion() { return ANNOTATION_LEDGER_FORMAT_VERSION; }
  async close() {
    if (this.closed) return;
    await this.#admissions.catch(() => {});
    this.closed = true;
    if (typeof this.#ledger.close === "function") await this.#ledger.close();
  }
  #assertOpen() { if (this.closed) throw new AnnotationLedgerError("closed", "annotation ledger is closed"); }
  #time() {
    const value = typeof this.now === "function" ? this.now() : this.now;
    const date = value === undefined ? new Date() : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new AnnotationLedgerError("clock_invalid", "annotation ledger clock is invalid");
    return date.toISOString();
  }
  #enqueue(work) {
    this.#assertOpen();
    const run = this.#admissions.catch(() => {}).then(work);
    this.#admissions = run.then(() => {}, () => {});
    return run;
  }

  async *#streamEntries() {
    if (typeof this.#ledger.streamRecords === "function") {
      const iterable = await Promise.resolve(this.#ledger.streamRecords({ batchSize: this.limits.maxRebuildBatch }));
      for await (const entry of iterable) yield entry;
      return;
    }
    if (typeof this.#ledger.listRecords !== "function") throw new AnnotationLedgerError("ledger_stream_unavailable", "underlying ledger does not expose bounded records");
    const maximum = this.#ledger.limits?.maxIndexEntries ?? this.limits.maxAnnotations * this.limits.maxRevisionsPerAnnotation;
    const result = await this.#ledger.listRecords({ limit: Math.min(maximum, this.limits.maxAnnotations * this.limits.maxRevisionsPerAnnotation) });
    if (!result || !Array.isArray(result.records) || result.truncated) throw new AnnotationLedgerError("ledger_stream_truncated", "underlying ledger cannot provide a complete bounded annotation stream");
    for (const entry of result.records) yield entry;
  }

  async #decodeEntry(entry) {
    if (!entry || typeof entry !== "object") return undefined;
    const record = entry.record;
    if (record?.event?.kind !== "annotation") return undefined;
    if (record.evidence?.class !== "human_annotation" || record.producer?.kind !== "human") throw new AnnotationLedgerError("persisted_record_untrusted", "annotation event is not a human annotation");
    const references = Array.isArray(entry.artifacts) ? entry.artifacts : [];
    if (references.length !== 1) throw new AnnotationLedgerError("annotation_artifact_invalid", "annotation revision must have exactly one artifact");
    const reference = references[0];
    if (reference.evidenceClass !== "human_annotation" || typeof reference.identity !== "string" || !/^annotation(?:-v1)?-/.test(reference.identity)) throw new AnnotationLedgerError("annotation_artifact_invalid", "annotation artifact is not in the protected namespace");
    let bytes;
    try {
      bytes = await this.#ledger.readArtifact(reference, { maxBytes: this.limits.maxAnnotationBytes });
      if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) throw new Error("not bytes");
    } catch (error) {
      if (error instanceof AnnotationLedgerError) throw error;
      throw new AnnotationLedgerError("annotation_artifact_unreadable", "annotation artifact could not be read", { causeCode: errorCode(error) });
    }
    let raw;
    try {
      raw = JSON.parse(decoder.decode(bytes));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
    } catch {
      throw new AnnotationLedgerError("annotation_artifact_invalid", "annotation artifact is not canonical JSON");
    }
    const legacy = raw.schema?.id !== ANNOTATION_V1_SCHEMA_ID || raw.schema?.version !== ANNOTATION_V1_SCHEMA_VERSION;
    const annotation = legacy
      ? migrateAnnotationV1(raw, { now: record.occurredAt, revisionId: record.event.id })
      : normalizeAnnotationV1(raw, { fillDefaults: false });
    const validation = validateAnnotationV1(annotation, { limits: this.limits, now: Date.parse(record.occurredAt) });
    if (!validation.ok) throw new AnnotationLedgerValidationError(validation.errors);
    if (!legacy && decoder.decode(bytes) !== canonicalJson(annotation)) throw new AnnotationLedgerError("annotation_artifact_noncanonical", "persisted v1 annotation bytes are not canonical");
    if (legacy && annotation.revision.id !== record.event.id) throw new AnnotationLedgerError("annotation_revision_binding_invalid", "migrated annotation revision is not bound to its event");
    if (!legacy && reference.identity !== annotationArtifactIdentity(annotation)) throw new AnnotationLedgerError("annotation_artifact_binding_invalid", "annotation artifact identity is not content bound");
    if (record.episode?.id !== annotationEpisodeId(annotation.id)) throw new AnnotationLedgerError("annotation_episode_binding_invalid", "annotation event is bound to the wrong episode");
    if (record.event.id !== annotation.revision.id) throw new AnnotationLedgerError("annotation_revision_binding_invalid", "annotation revision is not bound to its event identity");
    if (record.sequence !== annotation.revision.number - 1) throw new AnnotationLedgerError("annotation_sequence_invalid", "annotation revision number is not bound to its ledger sequence");
    if (record.occurredAt !== annotation.createdAt) throw new AnnotationLedgerError("annotation_timestamp_binding_invalid", "annotation timestamp is not bound to its event");
    if (record.producer.id !== annotation.author.id) throw new AnnotationLedgerError("annotation_author_binding_invalid", "annotation author is not bound to its event producer");
    if (reference.size !== bytes.byteLength || reference.digest !== sha256(bytes)) throw new AnnotationLedgerError("annotation_artifact_integrity_failed", "annotation artifact content address is invalid");
    return { annotation, entry: clone(entry), legacy };
  }

  async #rebuild() {
    const grouped = new Map();
    for await (const entry of this.#streamEntries()) {
      const decoded = await this.#decodeEntry(entry);
      if (!decoded) continue;
      const id = decoded.annotation.id;
      const list = grouped.get(id) ?? [];
      list.push(decoded);
      if (list.length > this.limits.maxRevisionsPerAnnotation) throw new AnnotationLedgerLimitError("maxRevisionsPerAnnotation", list.length, this.limits.maxRevisionsPerAnnotation);
      grouped.set(id, list);
      if (grouped.size > this.limits.maxAnnotations) throw new AnnotationLedgerLimitError("maxAnnotations", grouped.size, this.limits.maxAnnotations);
    }
    const histories = new Map();
    const heads = new Map();
    for (const [id, values] of grouped) {
      const revisions = sortedByRevision(values);
      const revisionIds = new Set();
      const revisionDigests = new Set();
      for (let index = 0; index < revisions.length; index += 1) {
        const current = revisions[index];
        const annotation = current.annotation;
        if (revisionIds.has(annotation.revision.id)) throw new AnnotationLedgerConflictError("revision_id_conflict", "annotation history repeats a revision identity", { annotationId: id });
        if (revisionDigests.has(annotation.contentDigest)) throw new AnnotationLedgerConflictError("revision_digest_conflict", "annotation history repeats a content identity", { annotationId: id });
        revisionIds.add(annotation.revision.id);
        revisionDigests.add(annotation.contentDigest);
        if (annotation.revision.number !== index + 1 || current.entry.record.sequence !== index) throw new AnnotationLedgerError("revision_sequence_invalid", "annotation revisions are not contiguous", { annotationId: id });
        const prior = revisions[index - 1]?.annotation;
        if (!prior) {
          if (annotation.revision.parentId !== undefined || annotation.revision.parentDigest !== undefined) throw new AnnotationLedgerError("revision_parent_orphaned", "the first annotation revision cannot have a parent", { annotationId: id });
          if (isAnnotationTombstone(annotation)) throw new AnnotationLedgerError("tombstone_orphan", "an annotation tombstone must follow an existing revision", { annotationId: id });
        } else {
          if (isAnnotationTombstone(prior)) throw new AnnotationLedgerError("revision_after_tombstone", "an annotation cannot be revised after its tombstone", { annotationId: id });
          if (annotation.revision.parentId !== prior.revision.id || annotation.revision.parentDigest !== prior.contentDigest) throw new AnnotationLedgerConflictError("revision_parent_conflict", "annotation revision does not extend the current durable head", { annotationId: id });
        }
      }
      // Walk the ancestry independently of the sorted sequence. This catches a
      // cycle or a repeated parent even if a future loader supplies records in a
      // different order.
      const byRevision = new Map(revisions.map((entry) => [entry.annotation.revision.id, entry.annotation]));
      for (const entry of revisions) {
        const seen = new Set([entry.annotation.revision.id]);
        let parentId = entry.annotation.revision.parentId;
        while (parentId !== undefined) {
          if (seen.has(parentId)) throw new AnnotationLedgerError("revision_cycle", "annotation revision ancestry contains a cycle", { annotationId: id });
          seen.add(parentId);
          const parent = byRevision.get(parentId);
          if (!parent) break;
          parentId = parent.revision.parentId;
        }
      }
      histories.set(id, revisions);
      heads.set(id, revisions.at(-1));
    }
    this.#history = histories;
    this.#heads = heads;
    return { annotations: heads.size, revisions: [...histories.values()].reduce((count, entries) => count + entries.length, 0), legacy: [...histories.values()].flat().filter((entry) => entry.legacy).length };
  }

  async rebuild() {
    this.#assertOpen();
    await this.#admissions.catch(() => {});
    return this.#rebuild();
  }

  #checkExpected(prior, expected) {
    const wanted = expectedRevisionValue(expected);
    if (!wanted) return;
    if (!prior) throw new AnnotationLedgerConflictError("revision_conflict", "expected revision does not exist", { reason: "missing_revision" });
    const current = prior;
    const matches = (wanted.number === undefined || wanted.number === current.revision.number)
      && (wanted.id === undefined || wanted.id === current.revision.id)
      && (wanted.digest === undefined || wanted.digest === current.contentDigest);
    if (!matches) throw new AnnotationLedgerConflictError("revision_conflict", "annotation revision is stale", { reason: "stale_revision", currentRevision: current.revision.number });
  }

  #candidate(input, options = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AnnotationLedgerValidationError([{ code: "annotation_invalid", message: "annotation must be an object", path: "" }]);
    const raw = clone(input);
    const explicitDigest = typeof raw.contentDigest === "string";
    const rawRevision = raw.revisionAncestry ?? raw.revision;
    const explicitNumber = Number.isSafeInteger(rawRevision) || Number.isSafeInteger(rawRevision?.number) || Number.isSafeInteger(rawRevision?.sequence) || Number.isSafeInteger(raw.revisionNumber);
    const explicitRevisionId = typeof raw.revisionId === "string" || typeof rawRevision?.id === "string";
    let annotation = normalizeAnnotationV1(raw, { now: options.now ?? this.#time(), fillDefaults: true });
    const id = ensureIdentifier(annotation.id, "annotation identity");
    const values = this.#history.get(id) ?? [];
    const priorEntry = this.#heads.get(id);
    const prior = priorEntry?.annotation;
    let revision = { ...(annotation.revision ?? {}) };
    if (!explicitNumber) revision.number = prior ? prior.revision.number + 1 : 1;
    if (prior && !explicitRevisionId) revision.id = `annotation-revision-${sha256(`${id}\u0000${revision.number}\u0000${prior.contentDigest}`).slice(0, 48)}`;
    if (!prior && !explicitRevisionId && !revision.id) revision.id = `annotation-revision-${sha256(`${id}\u0000${revision.number}`).slice(0, 48)}`;
    if (prior && options.inferParent === true) {
      revision.parentId ??= prior.revision.id;
      revision.parentDigest ??= prior.contentDigest;
    }
    annotation.revision = revision;
    if (!explicitDigest) annotation.contentDigest = annotationContentDigest(annotation);
    const existing = values.find((entry) => entry.annotation.revision.id === annotation.revision.id);
    if (existing) {
      if (existing.annotation.contentDigest === annotation.contentDigest && canonicalJson(existing.annotation) === canonicalJson(annotation)) return { annotation, prior, existing, idempotent: true };
      throw new AnnotationLedgerConflictError("revision_id_conflict", "revision identity is already bound to different content", { annotationId: id });
    }
    this.#checkExpected(prior, options.expectedRevision);
    if (annotation.revision.parentId === annotation.revision.id) throw new AnnotationLedgerError("revision_cycle", "a revision cannot be its own parent");
    if (!prior && (annotation.revision.parentId !== undefined || annotation.revision.parentDigest !== undefined)) throw new AnnotationLedgerError("revision_parent_orphaned", "a new annotation revision cannot name a parent");
    if (prior) {
      if (isAnnotationTombstone(prior)) throw new AnnotationLedgerConflictError("annotation_deleted", "a tombstoned annotation cannot receive another revision", { annotationId: id });
      if (annotation.revision.parentId === undefined || annotation.revision.parentDigest === undefined) throw new AnnotationLedgerConflictError("revision_parent_required", "an edit must name its expected parent revision", { annotationId: id });
      if (annotation.revision.parentId === annotation.revision.id) throw new AnnotationLedgerError("revision_cycle", "a revision cannot be its own parent");
      if (annotation.revision.parentId !== prior.revision.id || annotation.revision.parentDigest !== prior.contentDigest) throw new AnnotationLedgerConflictError("revision_parent_conflict", "revision parent is not the current durable head", { annotationId: id });
      if (annotation.revision.number !== prior.revision.number + 1) throw new AnnotationLedgerConflictError("revision_sequence_conflict", "revision number must extend the current head", { annotationId: id });
    } else if (annotation.revision.number !== 1) {
      throw new AnnotationLedgerError("revision_sequence_invalid", "the first annotation revision must be number one");
    }
    if (isAnnotationTombstone(annotation) && !prior) throw new AnnotationLedgerError("tombstone_orphan", "a tombstone requires an existing annotation identity");
    const validation = validateAnnotationV1(annotation, { limits: this.limits, now: Date.parse(options.now ?? this.#time()) });
    if (!validation.ok) throw new AnnotationLedgerValidationError(validation.errors);
    // A caller-provided digest is immutable input. The validator above checks
    // it; this explicit branch keeps the intent visible at the write boundary.
    if (!explicitDigest) annotation.contentDigest = validation.contentDigest;
    return { annotation, prior, existing: undefined, idempotent: false };
  }

  async #appendExclusive(input, options = {}) {
    this.#assertOpen();
    const prepared = this.#candidate(input, options);
    if (prepared.idempotent) return this.#result(prepared.annotation, "idempotent", prepared.existing?.entry);
    const annotation = prepared.annotation;
    const count = this.#heads.size + (prepared.prior ? 0 : 1);
    if (count > this.limits.maxAnnotations) throw new AnnotationLedgerLimitError("maxAnnotations", count, this.limits.maxAnnotations);
    const revisionCount = (this.#history.get(annotation.id)?.length ?? 0) + 1;
    if (revisionCount > this.limits.maxRevisionsPerAnnotation) throw new AnnotationLedgerLimitError("maxRevisionsPerAnnotation", revisionCount, this.limits.maxRevisionsPerAnnotation);
    const body = canonicalJson(annotation);
    const bytes = encoder.encode(body);
    if (bytes.byteLength > this.limits.maxAnnotationBytes) throw new AnnotationLedgerLimitError("maxAnnotationBytes", bytes.byteLength, this.limits.maxAnnotationBytes);
    const record = ticketRecord(annotation, { projectId: this.projectId, repositoryId: this.repositoryId, repositoryRevision: this.repositoryRevision, ticket: this.ticket });
    const artifact = { bytes, metadata: artifactMetadata(annotation) };
    try {
      if (typeof this.#ledger.appendEpisodeWithArtifactBatch !== "function") throw new AnnotationLedgerError("ledger_batch_unavailable", "annotation persistence requires the atomic episode/artifact admission API");
      const stored = await this.#ledger.appendEpisodeWithArtifactBatch(record, { artifacts: [artifact] });
      const reference = stored?.artifacts?.[0] ?? { digest: sha256(bytes), size: bytes.byteLength, ...artifact.metadata };
      const entry = { format: 2, type: "episode", record, artifacts: [reference], previousDigest: prepared.prior?.entry?.digest ?? null };
      if (stored?.digest) entry.digest = stored.digest;
      const historyEntry = { annotation: clone(annotation), entry: clone(entry), legacy: false };
      const history = [...(this.#history.get(annotation.id) ?? []), historyEntry];
      this.#history.set(annotation.id, history);
      this.#heads.set(annotation.id, historyEntry);
      return this.#result(annotation, stored?.status ?? "committed", entry, stored);
    } catch (error) {
      // The lower ledger reconciles post-publication faults. Rebuild the
      // projection before returning the error so a recovered commit can never
      // leave this facade with a phantom or missing head.
      await this.#rebuild().catch(() => {});
      if (error instanceof AnnotationLedgerError) throw error;
      if (error instanceof LedgerConflictError) throw new AnnotationLedgerConflictError("revision_conflict", "underlying ledger rejected the annotation revision", { reason: "underlying_conflict" });
      if (error instanceof LedgerLimitError) throw new AnnotationLedgerLimitError(error.details?.limit ?? "ledger", error.details?.actual ?? 0, error.details?.maximum ?? 0);
      if (error instanceof LedgerError) throw new AnnotationLedgerError(error.code ?? "storage_error", error.message);
      throw new AnnotationLedgerError("storage_error", "annotation revision persistence failed closed", { causeCode: errorCode(error) });
    }
  }

  #result(annotation, status, entry, stored = {}) {
    return {
      status,
      annotation: clone(annotation),
      revision: clone(annotation.revision),
      annotationId: annotation.id,
      revisionId: annotation.revision.id,
      contentDigest: annotation.contentDigest,
      digest: entry?.digest ?? stored?.digest ?? annotation.contentDigest,
      eventId: annotation.revision.id,
      ...(stored?.recovered ? { recovered: true } : {}),
    };
  }

  append(annotation, options = {}) { return this.#enqueue(() => this.#appendExclusive(annotation, options)); }
  appendRevision(annotation, options = {}) { return this.append(annotation, options); }
  add(annotation, options = {}) { return this.append(annotation, options); }

  async edit(id, changes = {}, options = {}) {
    return this.#enqueue(async () => {
      this.#assertOpen();
      ensureIdentifier(id, "annotation identity");
      const head = this.#heads.get(id);
      if (!head) throw new AnnotationLedgerError("annotation_not_found", "annotation identity is not present", { annotationId: id });
      this.#checkExpected(head.annotation, options.expectedRevision);
      if (isAnnotationTombstone(head.annotation)) throw new AnnotationLedgerConflictError("annotation_deleted", "a tombstoned annotation cannot be edited", { annotationId: id });
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new AnnotationLedgerError("edit_invalid", "annotation edit must be an object");
      const allowed = new Set(["type", "target", "author", "authorId", "sensitivity", "rationale", "content", "body", "value", "createdAt", "timestamp"]);
      for (const key of Object.keys(changes)) if (!allowed.has(key)) throw new AnnotationLedgerError("edit_field_invalid", `annotation edit field ${key} is immutable or unsupported`);
      const next = clone(head.annotation);
      for (const key of allowed) if (changes[key] !== undefined) next[key] = clone(changes[key]);
      if (next.body !== undefined) { next.content = next.body; delete next.body; }
      next.createdAt = changes.createdAt ?? changes.timestamp ?? this.#time();
      next.revision = { number: head.annotation.revision.number + 1, parentId: head.annotation.revision.id, parentDigest: head.annotation.contentDigest };
      delete next.contentDigest;
      delete next.tombstone;
      delete next.tombstoneReason;
      return this.#appendExclusive(next, { expectedRevision: options.expectedRevision, inferParent: true, now: next.createdAt });
    });
  }
  update(id, changes = {}, options = {}) { return this.edit(id, changes, options); }
  revise(id, changes = {}, options = {}) { return this.edit(id, changes, options); }

  async tombstone(id, options = {}) {
    return this.#enqueue(async () => {
      this.#assertOpen();
      ensureIdentifier(id, "annotation identity");
      const head = this.#heads.get(id);
      if (!head) throw new AnnotationLedgerError("tombstone_orphan", "a tombstone requires an existing annotation identity", { annotationId: id });
      this.#checkExpected(head.annotation, options.expectedRevision);
      if (isAnnotationTombstone(head.annotation)) return this.#result(head.annotation, "idempotent", head.entry);
      const reason = options.reason ?? options.rationale;
      if (typeof reason !== "string" || reason.length === 0) throw new AnnotationLedgerValidationError([{ code: "tombstone_reason_required", message: "a tombstone requires a bounded reason", path: "/tombstoneReason" }]);
      const next = clone(head.annotation);
      if (options.author !== undefined) next.author = typeof options.author === "string" ? { id: options.author, kind: "human" } : clone(options.author);
      if (options.authorId !== undefined) next.author = { id: options.authorId, kind: "human" };
      next.createdAt = options.deletedAt ?? options.createdAt ?? this.#time();
      next.rationale = reason;
      next.tombstone = true;
      next.tombstoneReason = reason;
      next.revision = { number: head.annotation.revision.number + 1, parentId: head.annotation.revision.id, parentDigest: head.annotation.contentDigest };
      delete next.contentDigest;
      return this.#appendExclusive(next, { expectedRevision: options.expectedRevision, inferParent: true, now: next.createdAt });
    });
  }
  delete(id, options = {}) { return this.tombstone(id, options); }
  remove(id, options = {}) { return this.tombstone(id, options); }
  deleteAnnotation(id, options = {}) { return this.tombstone(id, options); }
  removeAnnotation(id, options = {}) { return this.tombstone(id, options); }
  appendTombstone(id, options = {}) { return this.tombstone(id, options); }

  get(id, options = {}) {
    this.#assertOpen();
    const values = this.#history.get(id);
    if (!values) return undefined;
    if (options?.revision !== undefined || options?.revisionNumber !== undefined || options?.revisionId !== undefined) {
      const wanted = options.revisionId ?? options.revisionNumber ?? options.revision;
      const value = typeof wanted === "number" ? values.find((entry) => entry.annotation.revision.number === wanted) : values.find((entry) => entry.annotation.revision.id === wanted || entry.annotation.contentDigest === wanted);
      return value ? clone(value.annotation) : undefined;
    }
    return clone(this.#heads.get(id).annotation);
  }
  getAnnotation(id, options = {}) { return this.get(id, options); }
  getRevision(id, revision) { return this.get(id, { revision }); }
  has(id) { return this.get(id) !== undefined; }

  #filterCandidates(options = {}) {
    const { includeHistory = false, includeTombstones = false, includeDeleted, type, target, targetKind, targetId, authorId } = options;
    const showDeleted = includeDeleted ?? (includeTombstones || includeHistory);
    const source = includeHistory ? [...this.#history.values()].flat() : [...this.#heads.values()];
    return source.filter((entry) => {
      const annotation = entry.annotation;
      if (!showDeleted && isAnnotationTombstone(annotation)) return false;
      if (type !== undefined && annotation.type !== type) return false;
      if (authorId !== undefined && annotation.author.id !== authorId) return false;
      if (targetKind !== undefined && annotation.target.kind !== targetKind) return false;
      if (targetId !== undefined && annotation.target.id !== targetId) return false;
      if (target !== undefined) {
        if (typeof target === "string" && annotation.target.id !== target) return false;
        if (target && typeof target === "object") {
          if (target.kind !== undefined && annotation.target.kind !== target.kind) return false;
          if ((target.id ?? target.identity) !== undefined && annotation.target.id !== (target.id ?? target.identity)) return false;
          if (target.start !== undefined && annotation.target.start !== target.start) return false;
          if (target.end !== undefined && annotation.target.end !== target.end) return false;
        }
      }
      return true;
    }).sort((left, right) => left.annotation.id.localeCompare(right.annotation.id) || left.annotation.revision.number - right.annotation.revision.number || left.annotation.revision.id.localeCompare(right.annotation.revision.id));
  }

  #page(entries, { limit = this.limits.maxQueryRecords, maxBytes = this.limits.maxQueryBytes, cursor } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > this.limits.maxQueryRecords) throw new AnnotationLedgerLimitError("maxQueryRecords", limit, this.limits.maxQueryRecords);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.limits.maxQueryBytes) throw new AnnotationLedgerLimitError("maxQueryBytes", maxBytes, this.limits.maxQueryBytes);
    const offset = cursorDecode(cursor);
    if (offset > entries.length) throw new AnnotationLedgerError("cursor_invalid", "annotation cursor is beyond the result set");
    const page = [];
    let bytes = 0;
    let index = offset;
    while (index < entries.length && page.length < limit) {
      const annotation = entries[index].annotation;
      const size = encoder.encode(canonicalJson(annotation)).byteLength;
      if (bytes + size > maxBytes) {
        if (page.length === 0) throw new AnnotationLedgerLimitError("maxQueryBytes", bytes + size, maxBytes);
        break;
      }
      page.push(clone(annotation));
      bytes += size;
      index += 1;
    }
    const truncated = index < entries.length;
    return {
      annotations: page,
      revisions: page,
      cursor: cursor ?? null,
      nextCursor: truncated ? cursorEncode(index) : null,
      truncated,
      bytes,
    };
  }

  list(options = {}) {
    this.#assertOpen();
    return this.#page(this.#filterCandidates(options), options);
  }
  listAnnotations(options = {}) { return this.list(options); }
  listLatest(options = {}) { return this.list({ ...options, includeHistory: false }); }
  listHistory(id, options = {}) {
    this.#assertOpen();
    ensureIdentifier(id, "annotation identity");
    const values = this.#history.get(id) ?? [];
    return this.#page(sortedByRevision(values), { ...options, includeHistory: true });
  }
  listRevisions(id, options = {}) { return this.listHistory(id, options); }
  getHistory(id, options = {}) { return this.listHistory(id, options); }
  query(options = {}) { return this.list(options); }

  #orderedEntries(options = {}) {
    return this.#filterCandidates({
      ...options,
      includeHistory: options.includeHistory !== false,
      includeTombstones: options.includeTombstones !== false,
      includeDeleted: options.includeTombstones !== false,
    });
  }

  async export(options = {}) {
    this.#assertOpen();
    await this.#admissions.catch(() => {});
    const maxBytes = options.maxBytes ?? this.limits.maxExportBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.limits.maxExportBytes) throw new AnnotationLedgerLimitError("maxExportBytes", maxBytes, this.limits.maxExportBytes);
    const entries = this.#orderedEntries(options);
    const annotations = entries.map((entry) => clone(entry.annotation));
    const payload = { format: "annotation-ledger-export", version: ANNOTATION_LEDGER_FORMAT_VERSION, schema: { id: ANNOTATION_V1_SCHEMA_ID, version: ANNOTATION_V1_SCHEMA_VERSION }, annotations };
    const contents = canonicalJson(payload);
    const bytes = encoder.encode(contents).byteLength;
    if (bytes > maxBytes) throw new AnnotationLedgerLimitError("maxExportBytes", bytes, maxBytes);
    return { ...payload, digest: sha256(contents), bytes, contents, truncated: false };
  }
  exportAnnotations(options = {}) { return this.export(options); }
  exportLedger(options = {}) { return this.export(options); }
  snapshot(options = {}) { return this.export(options); }

  async backup(options = {}) {
    this.#assertOpen();
    await this.#admissions.catch(() => {});
    if (typeof this.#ledger.backup !== "function") throw new AnnotationLedgerError("backup_unavailable", "underlying ledger does not expose backup");
    try { return await this.#ledger.backup({ maxBytes: options.maxBytes ?? this.limits.maxExportBytes }); }
    catch (error) {
      if (error instanceof LedgerLimitError) throw new AnnotationLedgerLimitError(error.details?.limit ?? "maxExportBytes", error.details?.actual ?? 0, error.details?.maximum ?? 0);
      if (error instanceof AnnotationLedgerError) throw error;
      throw new AnnotationLedgerError("backup_failed", "annotation ledger backup failed closed", { causeCode: errorCode(error) });
    }
  }

  async verifyIntegrity() {
    this.#assertOpen();
    await this.#admissions.catch(() => {});
    let underlying = { ok: true, findings: [], quarantines: [] };
    if (typeof this.#ledger.verifyIntegrity === "function") underlying = await this.#ledger.verifyIntegrity();
    try {
      const summary = await this.#rebuild();
      return { ok: underlying.ok === true, annotations: summary.annotations, revisions: summary.revisions, findings: [...(underlying.findings ?? [])], quarantines: [...(underlying.quarantines ?? [])] };
    } catch (error) {
      return { ok: false, annotations: this.#heads.size, revisions: [...this.#history.values()].reduce((count, entries) => count + entries.length, 0), findings: [...(underlying.findings ?? []), { code: errorCode(error) }], quarantines: [...(underlying.quarantines ?? [])] };
    }
  }

  async migrate(options = {}) {
    return this.#enqueue(async () => {
      this.#assertOpen();
      const fromVersion = options.fromVersion;
      const toVersion = options.toVersion;
      const supportedSource = fromVersion === undefined || fromVersion === 0 || fromVersion === "0" || fromVersion === 1 || fromVersion === "1";
      if (!supportedSource) throw new AnnotationLedgerError("migration_source_unsupported", "annotation migration source version is unsupported", { fromVersion });
      // Annotation payload migration is read/export based: legacy artifacts are
      // normalized to v1 during rebuild and are never destructively rewritten.
      const targetIsCurrent = toVersion === undefined || toVersion === ANNOTATION_LEDGER_FORMAT_VERSION || toVersion === 1 || toVersion === "1";
      if (targetIsCurrent) {
        const summary = await this.#rebuild();
        return { status: summary.legacy > 0 ? "migrated" : "already_current", version: ANNOTATION_LEDGER_FORMAT_VERSION, migrated: summary.legacy, annotations: summary.annotations, revisions: summary.revisions };
      }
      if (typeof this.#ledger.migrate !== "function") throw new AnnotationLedgerError("migration_unavailable", "underlying ledger does not expose migration");
      const batchSize = options.batchSize ?? this.limits.maxMigrationBatch;
      if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > this.limits.maxMigrationBatch) throw new AnnotationLedgerLimitError("maxMigrationBatch", batchSize, this.limits.maxMigrationBatch);
      const result = await this.#ledger.migrate({ fromVersion, toVersion, batchSize });
      const summary = await this.#rebuild();
      return { ...result, annotationVersion: ANNOTATION_LEDGER_FORMAT_VERSION, annotations: summary.annotations, revisions: summary.revisions };
    });
  }
  migrateAnnotations(options = {}) { return this.migrate(options); }
  migratePayload(payload, options = {}) { return migrateAnnotationV1(payload, options); }
}

export const AnnotationStore = AnnotationLedger;
export const AnnotationLedgerConflict = AnnotationLedgerConflictError;
export const AnnotationLedgerValidation = AnnotationLedgerValidationError;
export const AnnotationLedgerLimit = AnnotationLedgerLimitError;
export default AnnotationLedger;
