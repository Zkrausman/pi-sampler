import { TextEncoder } from "node:util";
import { EpisodeEvolutionLedger, LedgerConflictError } from "./episode-evolution-ledger.mjs";
import {
  AuthoritativeReceiptValidationError,
  canonicalJson,
  idempotencyEventId,
  receiptPayloadDigest,
  sha256Hex,
  validateReceiptFreshness,
  validateAuthoritativeReceiptV1,
  verifyAuthoritativeReceiptV1,
} from "../contracts/authoritative-receipt-v1.mjs";

const encoder = new TextEncoder();
const artifactMetadata = (artifact) => ({
  identity: canonicalJson(artifact.identity),
  evidenceClass: artifact.evidenceClass,
  coverage: artifact.coverage.status,
  provenance: canonicalJson(artifact.provenance),
  sensitivity: artifact.sensitivity,
});
const receiptArtifactMetadata = (receipt) => ({
  identity: receipt.receipt.id,
  evidenceClass: "observed_evidence",
  coverage: receipt.observed.coverage.status,
  provenance: canonicalJson({ producerId: receipt.producer.id, authorityId: receipt.authority.id, receiptId: receipt.receipt.id, operationId: receipt.operation.id }),
  sensitivity: receipt.observed.sensitivity,
});

export class AuthoritativeReceiptLedgerError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "AuthoritativeReceiptLedgerError"; this.code = code; this.details = details; }
}

/**
 * Narrow admission facade over the AIDEV-124 EpisodeEvolutionLedger. It stores
 * receipt and evidence bytes as AIDEV-124 content-addressed artifacts and uses
 * its durable, immutable event admission for idempotency/restart behavior. It
 * does not expose an adapter, lifecycle transition, or generic write API.
 */
export class AuthoritativeReceiptLedger {
  static async open({ root, trustRoots, freshness, limits, now, faultInjector } = {}) {
    const roots = trustRoots instanceof Map ? [...trustRoots.values()] : trustRoots;
    if (!Array.isArray(roots) || roots.length === 0) throw new AuthoritativeReceiptLedgerError("trust_roots_required", "at least one configured connected-authority trust root is required");
    const authorityIds = roots.map((entry) => entry?.authorityId).filter((id) => typeof id === "string");
    if (new Set(authorityIds).size !== authorityIds.length || authorityIds.length !== roots.length) throw new AuthoritativeReceiptLedgerError("trust_roots_invalid", "configured connected-authority roots must have unique authority IDs");
    // EpisodeEvolutionLedger is only the private AIDEV-124 persistence
    // primitive. Its synchronous legacy attestation hook permits bootstrap
    // loading; no facade is returned until every persisted receipt is rerun
    // through the configured authoritative verifier below.
    const ledger = await EpisodeEvolutionLedger.open({ root, limits, faultInjector, trustedAuthorityIds: authorityIds, verifyAttestation: () => true });
    const service = new AuthoritativeReceiptLedger({ ledger, trustRoots: roots, freshness, now, limits });
    try { await service.#reverifyPersisted(); return service; }
    catch (error) { await ledger.close(); throw new AuthoritativeReceiptLedgerError("persisted_receipt_reverification_failed", "persisted authoritative receipt verification failed closed", { cause: error.message }); }
  }

  #ledger;
  #admissions = Promise.resolve();
  constructor({ ledger, trustRoots, freshness, now, limits }) {
    this.#ledger = ledger;
    this.trustRoots = trustRoots;
    this.freshness = freshness;
    this.now = now;
    this.limits = limits;
  }

  async close() { await this.#ledger.close(); }
  #now() { return typeof this.now === "function" ? this.now() : this.now ?? Date.now(); }
  #enqueue(work) {
    const next = this.#admissions.catch(() => {}).then(work);
    this.#admissions = next.then(() => {}, () => {});
    return next;
  }
  #record(receipt, sequence) {
    const coverage = receipt.observed.coverage;
    return {
      schema: { id: "https://pi-sampler.dev/contracts/ticket-episode/v1", version: "1.0.0" },
      project: receipt.project,
      repository: receipt.repository,
      ticket: receipt.ticket,
      episode: receipt.episode,
      attempt: { id: `operation-${sha256Hex(receipt.operation.id)}` },
      session: { id: `receipt-${receipt.receipt.id}` },
      agentRun: { agentId: receipt.authority.id, runId: receipt.operation.id },
      event: { id: idempotencyEventId(receipt.idempotency.key), kind: "artifact" },
      // Only the configured authority is represented as the Ticket Episode
      // observed-evidence producer. The external adapter/caller identity is
      // preserved inside the immutable receipt artifact, never elevated.
      producer: { id: receipt.authority.id, kind: "connected_authority" },
      occurredAt: receipt.observed.observedAt,
      sequence,
      evidence: { class: "observed_evidence", authority: { level: "attested", authorityId: receipt.authority.id, attestationId: receipt.receipt.id } },
      state: coverage.status === "complete" ? "complete" : "partial",
      coverage: { status: coverage.status, expectedEventCount: coverage.expectedCount, observedEventCount: coverage.observedCount, missingEventIds: coverage.missingIds },
    };
  }
  async #existing(receipt, payloadDigest) {
    const eventId = idempotencyEventId(receipt.idempotency.key);
    const entry = await this.#ledger.findEvent(eventId);
    if (!entry) return undefined;
    const receiptArtifact = entry.artifacts.find((artifact) => artifact.identity === receipt.receipt.id && artifact.evidenceClass === "observed_evidence");
    if (receiptArtifact?.digest === payloadDigest
      && entry.record.project.id === receipt.project.id
      && entry.record.ticket.system === receipt.ticket.system
      && entry.record.ticket.id === receipt.ticket.id
      && entry.record.episode.id === receipt.episode.id
      && entry.record.agentRun.runId === receipt.operation.id
      && entry.record.producer.id === receipt.authority.id) return entry;
    throw new AuthoritativeReceiptLedgerError("idempotency_conflict", "idempotency key is already bound to different canonical receipt content or ownership scope", { idempotencyKey: receipt.idempotency.key });
  }
  async #reverifyPersisted() {
    const listed = await this.#ledger.listRecords();
    if (listed.truncated) throw new AuthoritativeReceiptLedgerError("persisted_receipt_scan_truncated", "cannot reverify a truncated persisted receipt inventory");
    for (const entry of listed.records) {
      if (entry.record.evidence.class !== "observed_evidence") throw new AuthoritativeReceiptLedgerError("persisted_record_not_authoritative", "receipt ledger contains a non-authoritative record");
      const ref = entry.artifacts.find((artifact) => artifact.identity === entry.record.evidence.authority.attestationId && artifact.evidenceClass === "observed_evidence");
      if (!ref) throw new AuthoritativeReceiptLedgerError("persisted_receipt_artifact_missing", "persisted receipt event lacks its receipt artifact");
      let receipt; try { receipt = JSON.parse(new TextDecoder().decode(await this.#ledger.readArtifact(ref))); }
      catch { throw new AuthoritativeReceiptLedgerError("persisted_receipt_artifact_invalid", "persisted receipt artifact is not valid canonical JSON"); }
      const verified = await verifyAuthoritativeReceiptV1(receipt, { trustRoots: this.trustRoots, freshness: this.freshness, now: Date.parse(receipt?.observed?.observedAt), limits: this.limits });
      if (!verified.ok || receiptPayloadDigest(receipt) !== ref.digest || !this.#matchesPersistedRecord(entry.record, receipt)) throw new AuthoritativeReceiptLedgerError("persisted_receipt_invalid", "persisted receipt fails authority, content, or identity binding verification");
    }
  }
  #matchesPersistedRecord(record, receipt) {
    return record.event.id === idempotencyEventId(receipt.idempotency.key)
      && record.project.id === receipt.project.id && record.repository.id === receipt.repository.id && record.repository.revision === receipt.repository.revision
      && record.ticket.system === receipt.ticket.system && record.ticket.id === receipt.ticket.id && record.episode.id === receipt.episode.id
      && record.agentRun.runId === receipt.operation.id && record.producer.id === receipt.authority.id && record.occurredAt === receipt.observed.observedAt
      && record.evidence.authority.authorityId === receipt.authority.id && record.evidence.authority.attestationId === receipt.receipt.id;
  }
  async #writeEvidenceArtifacts(receipt, artifactBodies) {
    if (!Array.isArray(artifactBodies) || artifactBodies.length !== receipt.observed.artifacts.length) throw new AuthoritativeReceiptLedgerError("artifact_bodies_required", "every declared observed artifact requires exactly one supplied byte body");
    const supplied = new Map();
    for (const material of artifactBodies) {
      if (!material || typeof material !== "object" || typeof material.artifactId !== "string" || !(material.bytes instanceof Uint8Array) || supplied.has(material.artifactId)) throw new AuthoritativeReceiptLedgerError("artifact_body_invalid", "artifact bodies must be unique Uint8Array values keyed by artifactId");
      supplied.set(material.artifactId, material.bytes);
    }
    const references = [];
    for (const artifact of receipt.observed.artifacts) {
      const bytes = supplied.get(artifact.id);
      if (!bytes) throw new AuthoritativeReceiptLedgerError("artifact_body_missing", "declared artifact body is missing", { artifactId: artifact.id });
      if (bytes.byteLength !== artifact.size || sha256Hex(bytes) !== artifact.digest) throw new AuthoritativeReceiptLedgerError("artifact_content_mismatch", "artifact bytes do not match declared content address and size", { artifactId: artifact.id });
      const stored = await this.#ledger.writeArtifact(bytes, artifactMetadata(artifact));
      references.push(stored);
    }
    return references;
  }

  async accept(receipt, { artifactBodies } = {}) { return this.#enqueue(() => this.#accept(receipt, { artifactBodies })); }
  async #accept(receipt, { artifactBodies } = {}) {
    // Structural validation happens before lookup so malformed callers cannot
    // make the idempotency lookup dereference untrusted identity fields.
    const structural = validateAuthoritativeReceiptV1(receipt, { limits: this.limits });
    if (!structural.ok) throw new AuthoritativeReceiptValidationError(structural.errors);
    const payloadDigest = receiptPayloadDigest(receipt);
    const existing = await this.#existing(receipt, payloadDigest);
    if (existing) return { status: "idempotent", eventId: existing.record.event.id, receiptDigest: payloadDigest, freshness: validateReceiptFreshness(receipt, { now: this.#now(), freshness: this.freshness }) };
    const verified = await verifyAuthoritativeReceiptV1(receipt, { trustRoots: this.trustRoots, freshness: this.freshness, now: this.#now(), limits: this.limits });
    if (!verified.ok) throw new AuthoritativeReceiptValidationError(verified.errors);
    // Verification finishes before any artifact/record publication. A failed
    // verifier therefore has no durable authoritative state to expose.
    const artifacts = await this.#writeEvidenceArtifacts(receipt, artifactBodies);
    const receiptBytes = encoder.encode(verified.canonicalPayload);
    const receiptArtifact = await this.#ledger.writeArtifact(receiptBytes, receiptArtifactMetadata(receipt));
    const prior = await this.#ledger.queryEpisode(receipt.episode.id);
    if (prior.truncated) throw new AuthoritativeReceiptLedgerError("episode_sequence_unavailable", "bounded episode query cannot derive a safe next sequence");
    const sequence = prior.records.length === 0 ? 0 : prior.records.at(-1).record.sequence + 1;
    const episodeRecord = this.#record(receipt, sequence);
    try {
      const result = await this.#ledger.appendEpisode(episodeRecord, { artifacts: [...artifacts, receiptArtifact] });
      return { status: result.status, eventId: episodeRecord.event.id, receiptDigest: payloadDigest, freshness: verified.freshness };
    } catch (error) {
      if (error instanceof LedgerConflictError) throw new AuthoritativeReceiptLedgerError("idempotency_conflict", "idempotency key is already bound to different canonical receipt content or ownership scope", { idempotencyKey: receipt.idempotency.key, cause: error.details });
      throw error;
    }
  }

  /** Returns stale state explicitly; stored evidence is never silently current. */
  async lookup({ episodeId, idempotencyKey }) {
    const query = await this.#ledger.queryEpisode(episodeId);
    const eventId = idempotencyEventId(idempotencyKey);
    const entry = query.records.find((candidate) => candidate.record.event.id === eventId);
    if (!entry) return { status: "missing", eventId };
    const freshness = validateReceiptFreshness({ observed: { observedAt: entry.record.occurredAt }, receipt: { issuedAt: entry.record.occurredAt, expiresAt: entry.record.occurredAt } }, { now: this.#now(), freshness: { ...this.freshness, requireExpiresAt: false } });
    return { status: freshness.ok ? "stored_not_reverified" : "stale", eventId, digest: entry.digest, freshness };
  }
}
