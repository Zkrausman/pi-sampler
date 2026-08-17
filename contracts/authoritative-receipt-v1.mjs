import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

export const AUTHORITATIVE_RECEIPT_V1_SCHEMA_ID = "https://pi-sampler.dev/contracts/authoritative-receipt/v1";
export const AUTHORITATIVE_RECEIPT_V1_SCHEMA_VERSION = "1.0.0";
export const DEFAULT_RECEIPT_LIMITS = Object.freeze({ maxReceiptBytes: 64 * 1024, maxArtifacts: 32, maxClaimEntries: 32, maxVerifierTimeoutMs: 5_000 });
export const DEFAULT_FRESHNESS_POLICY = Object.freeze({ maxAgeMs: 5 * 60 * 1000, maxFutureSkewMs: 30 * 1000, requireExpiresAt: true });

const identifier = (title, maxLength = 128) => Type.String({ title, minLength: 1, maxLength, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$" });
const digest = Type.String({ title: "Lowercase SHA-256 digest", pattern: "^[a-f0-9]{64}$" });
const revision = Type.String({ title: "Immutable Git revision", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" });
const timestamp = Type.String({ title: "Canonical UTC RFC 3339 timestamp", format: "date-time" });
const sensitivity = Type.Union([Type.Literal("public"), Type.Literal("internal"), Type.Literal("confidential"), Type.Literal("restricted")]);
const coverageStatus = Type.Union([Type.Literal("complete"), Type.Literal("partial")]);
const evidenceClass = Type.Union([Type.Literal("observed_evidence"), Type.Literal("human_annotation"), Type.Literal("caller_claim"), Type.Literal("model_inference")]);
const artifactReference = Type.Object({
  id: identifier("Artifact identity"),
  digest,
  size: Type.Integer({ minimum: 0 }),
  identity: Type.Object({ id: identifier("Artifact source identity"), kind: identifier("Artifact identity kind", 64) }, { additionalProperties: false }),
  evidenceClass,
  coverage: Type.Object({ status: coverageStatus, expectedCount: Type.Integer({ minimum: 1 }), observedCount: Type.Integer({ minimum: 0 }), missingIds: Type.Array(identifier("Missing artifact coverage identity"), { uniqueItems: true, maxItems: 128 }) }, { additionalProperties: false }),
  provenance: Type.Object({ producerId: identifier("Artifact producer identity"), authorityId: identifier("Artifact authority identity"), receiptId: identifier("Artifact receipt identity"), operationId: identifier("Artifact operation identity") }, { additionalProperties: false }),
  sensitivity,
}, { additionalProperties: false });

/**
 * Structural source for the authoritative-receipt contract and generated JSON
 * Schema. Semantic validation below is authoritative: JSON Schema cannot safely
 * express freshness, content-addressing, trust-root, or cross-field rules.
 */
export const AuthoritativeReceiptV1Schema = Type.Object({
  schema: Type.Object({ id: Type.Literal(AUTHORITATIVE_RECEIPT_V1_SCHEMA_ID), version: Type.Literal(AUTHORITATIVE_RECEIPT_V1_SCHEMA_VERSION) }, { additionalProperties: false }),
  receipt: Type.Object({ id: identifier("Receipt identity"), issuedAt: timestamp, expiresAt: timestamp }, { additionalProperties: false }),
  project: Type.Object({ id: identifier("Project identity") }, { additionalProperties: false }),
  repository: Type.Object({ id: identifier("Repository identity"), revision }, { additionalProperties: false }),
  ticket: Type.Object({ system: identifier("Work-item system", 64), id: identifier("Ticket identity") }, { additionalProperties: false }),
  episode: Type.Object({ id: identifier("Episode identity") }, { additionalProperties: false }),
  operation: Type.Object({ id: identifier("Operation identity"), kind: identifier("Operation kind", 64) }, { additionalProperties: false }),
  // An adapter may transport an authority receipt, but is never itself the
  // authority. Callers, models, and generic tools are confined to claims.
  producer: Type.Object({ id: identifier("External producer identity"), kind: Type.Literal("adapter") }, { additionalProperties: false }),
  authority: Type.Object({ id: identifier("Configured authority identity"), attestation: Type.Object({ id: identifier("Attestation identity"), bindingDigest: digest }, { additionalProperties: false }) }, { additionalProperties: false }),
  idempotency: Type.Object({ key: identifier("Ownership idempotency key", 128) }, { additionalProperties: false }),
  observed: Type.Object({
    observedAt: timestamp,
    payload: Type.Object({ artifactId: identifier("Payload artifact identity"), digest, size: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
    coverage: Type.Object({ status: coverageStatus, expectedCount: Type.Integer({ minimum: 1 }), observedCount: Type.Integer({ minimum: 0 }), missingIds: Type.Array(identifier("Missing observation identity"), { uniqueItems: true, maxItems: 128 }) }, { additionalProperties: false }),
    artifacts: Type.Array(artifactReference, { minItems: 1, maxItems: DEFAULT_RECEIPT_LIMITS.maxArtifacts, uniqueItems: true }),
    sensitivity,
  }, { additionalProperties: false }),
  // Claims deliberately have neither authority nor observed-evidence fields.
  // They are retained as untrusted input and participate in idempotency only.
  claims: Type.Object({
    class: Type.Union([Type.Literal("caller_claim"), Type.Literal("model_inference")]),
    producer: Type.Object({ id: identifier("Claim producer identity"), kind: Type.Union([Type.Literal("adapter"), Type.Literal("caller"), Type.Literal("system"), Type.Literal("model"), Type.Literal("generic_tool")]) }, { additionalProperties: false }),
    entries: Type.Array(Type.Object({ name: identifier("Claim name", 64), valueDigest: digest, valueSize: Type.Integer({ minimum: 0 }), sensitivity }, { additionalProperties: false }), { maxItems: DEFAULT_RECEIPT_LIMITS.maxClaimEntries }),
  }, { additionalProperties: false }),
}, { $schema: "https://json-schema.org/draft/2020-12/schema", $id: AUTHORITATIVE_RECEIPT_V1_SCHEMA_ID, title: "Authoritative adapter receipt v1", additionalProperties: false });

const compiled = Compile(AuthoritativeReceiptV1Schema);
const sensitivityRank = new Map([["public", 0], ["internal", 1], ["confidential", 2], ["restricted", 3]]);
const text = new TextEncoder();
const issue = (code, message, path = "") => ({ code, message, path });

export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
export function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }
export function canonicalReceiptPayload(receipt) { return canonicalJson(receipt); }
export function receiptPayloadDigest(receipt) { return sha256Hex(canonicalReceiptPayload(receipt)); }
export function idempotencyEventId(key) { return `authority-receipt-${sha256Hex(key)}`; }
export function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }

/** The exact object an authority verifier must bind and return the digest for. */
export function authoritativeReceiptBinding(receipt) {
  return {
    schema: receipt.schema,
    receipt: receipt.receipt,
    project: receipt.project,
    repository: receipt.repository,
    ticket: receipt.ticket,
    episode: receipt.episode,
    operation: receipt.operation,
    producer: receipt.producer,
    authority: { id: receipt.authority.id, attestation: { id: receipt.authority.attestation.id } },
    idempotency: receipt.idempotency,
    observed: receipt.observed,
  };
}
export function authoritativeReceiptBindingDigest(receipt) { return sha256Hex(canonicalJson(authoritativeReceiptBinding(receipt))); }

function coverageErrors(coverage, path, errors) {
  if (coverage.status === "complete" && (coverage.expectedCount !== coverage.observedCount || coverage.missingIds.length !== 0)) errors.push(issue("coverage_complete_inconsistent", "complete coverage must include every expected item and no missing IDs", path));
  if (coverage.status === "partial" && (coverage.observedCount >= coverage.expectedCount || coverage.missingIds.length === 0 || coverage.missingIds.length !== coverage.expectedCount - coverage.observedCount)) errors.push(issue("coverage_partial_undeclared", "partial coverage must name every count-implied missing item", path));
}
function configuredLimits(limits = {}) {
  const value = { ...DEFAULT_RECEIPT_LIMITS, ...limits };
  for (const [key, limit] of Object.entries(value)) if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError(`invalid receipt limit ${key}`);
  return value;
}
function configuredFreshness(policy = {}) {
  const value = { ...DEFAULT_FRESHNESS_POLICY, ...policy };
  for (const key of ["maxAgeMs", "maxFutureSkewMs"]) if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new TypeError(`invalid freshness policy ${key}`);
  if (typeof value.requireExpiresAt !== "boolean") throw new TypeError("invalid freshness policy requireExpiresAt");
  return value;
}

/** Performs structural and semantic checks that need no configured authority. */
export function validateAuthoritativeReceiptV1(receipt, { limits } = {}) {
  const errors = [...compiled.Errors(receipt)].map((error) => issue("schema_invalid", error.message, error.path));
  if (errors.length) return { ok: false, errors };
  const configured = configuredLimits(limits);
  const canonical = canonicalReceiptPayload(receipt);
  if (text.encode(canonical).byteLength > configured.maxReceiptBytes) errors.push(issue("receipt_oversized", "canonical receipt exceeds maxReceiptBytes", "/"));
  for (const [path, value] of [["/receipt/issuedAt", receipt.receipt.issuedAt], ["/receipt/expiresAt", receipt.receipt.expiresAt], ["/observed/observedAt", receipt.observed.observedAt]]) if (!canonicalTimestamp(value)) errors.push(issue("timestamp_not_canonical", "timestamps must be canonical UTC RFC 3339 values with milliseconds", path));
  if (Date.parse(receipt.receipt.expiresAt) <= Date.parse(receipt.receipt.issuedAt)) errors.push(issue("receipt_expiry_invalid", "expiresAt must be after issuedAt", "/receipt/expiresAt"));
  if (Date.parse(receipt.observed.observedAt) > Date.parse(receipt.receipt.issuedAt)) errors.push(issue("observation_after_issuance", "observedAt must not be after the receipt was issued", "/observed/observedAt"));
  if (receipt.producer.id === receipt.authority.id) errors.push(issue("producer_self_attestation", "an adapter cannot be its own connected authority", "/producer/id"));
  if (receipt.claims.class === "model_inference" && receipt.claims.producer.kind !== "model") errors.push(issue("claim_producer_invalid", "model_inference claims require a model producer", "/claims/producer/kind"));
  if (receipt.claims.class === "caller_claim" && receipt.claims.producer.kind === "model") errors.push(issue("claim_producer_invalid", "caller_claim cannot be emitted by a model", "/claims/producer/kind"));
  if (receipt.observed.artifacts.length > configured.maxArtifacts) errors.push(issue("artifact_count_exceeded", "receipt exceeds configured artifact count", "/observed/artifacts"));
  if (receipt.claims.entries.length > configured.maxClaimEntries) errors.push(issue("claim_count_exceeded", "receipt exceeds configured claim entry count", "/claims/entries"));
  coverageErrors(receipt.observed.coverage, "/observed/coverage", errors);
  const artifactIds = new Set(); let greatestSensitivity = 0; let hasPartialArtifact = false; let payloadFound = false;
  for (let index = 0; index < receipt.observed.artifacts.length; index += 1) {
    const artifact = receipt.observed.artifacts[index], path = `/observed/artifacts/${index}`;
    if (artifactIds.has(artifact.id)) errors.push(issue("duplicate_artifact_id", "artifact IDs must be unique", `${path}/id`)); else artifactIds.add(artifact.id);
    if (artifact.evidenceClass !== "observed_evidence") errors.push(issue("artifact_evidence_class_invalid", "authoritative observations may reference only observed_evidence artifacts", `${path}/evidenceClass`));
    coverageErrors(artifact.coverage, `${path}/coverage`, errors);
    if (artifact.coverage.status === "partial") hasPartialArtifact = true;
    greatestSensitivity = Math.max(greatestSensitivity, sensitivityRank.get(artifact.sensitivity));
    if (artifact.provenance.producerId !== receipt.producer.id || artifact.provenance.authorityId !== receipt.authority.id || artifact.provenance.receiptId !== receipt.receipt.id || artifact.provenance.operationId !== receipt.operation.id) errors.push(issue("artifact_provenance_mismatch", "artifact provenance must bind receipt producer, authority, receipt, and operation", `${path}/provenance`));
    if (artifact.id === receipt.observed.payload.artifactId) {
      payloadFound = true;
      if (artifact.digest !== receipt.observed.payload.digest || artifact.size !== receipt.observed.payload.size) errors.push(issue("payload_artifact_mismatch", "payload digest and size must equal its artifact reference", "/observed/payload"));
    }
  }
  if (!payloadFound) errors.push(issue("payload_artifact_missing", "payload must name one declared content-addressed artifact", "/observed/payload/artifactId"));
  if (sensitivityRank.get(receipt.observed.sensitivity) < greatestSensitivity) errors.push(issue("sensitivity_downgrade", "receipt sensitivity must be at least the most sensitive artifact", "/observed/sensitivity"));
  if (hasPartialArtifact && receipt.observed.coverage.status === "complete") errors.push(issue("partial_artifact_coverage", "partial artifact coverage cannot support a complete observation", "/observed/coverage"));
  if (receipt.authority.attestation.bindingDigest !== authoritativeReceiptBindingDigest(receipt)) errors.push(issue("attestation_binding_mismatch", "attestation bindingDigest must bind the canonical receipt observation", "/authority/attestation/bindingDigest"));
  return { ok: errors.length === 0, errors, canonicalPayload: canonical, payloadDigest: sha256Hex(canonical) };
}

export function validateReceiptFreshness(receipt, { now = Date.now(), freshness } = {}) {
  const policy = configuredFreshness(freshness);
  const errors = [];
  const observedAt = Date.parse(receipt.observed.observedAt), issuedAt = Date.parse(receipt.receipt.issuedAt), expiresAt = Date.parse(receipt.receipt.expiresAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return { ok: false, errors: [issue("timestamp_invalid", "freshness requires valid canonical timestamps")] };
  if (observedAt > now + policy.maxFutureSkewMs || issuedAt > now + policy.maxFutureSkewMs) errors.push(issue("evidence_future_dated", "observed evidence or receipt issuance exceeds configured future clock skew", "/observed/observedAt"));
  if (now - observedAt > policy.maxAgeMs || now - issuedAt > policy.maxAgeMs) errors.push(issue("evidence_stale", "observed evidence or receipt issuance exceeds configured max age", "/observed/observedAt"));
  if (policy.requireExpiresAt && expiresAt <= now) errors.push(issue("evidence_expired", "receipt is expired under configured freshness policy", "/receipt/expiresAt"));
  return { ok: errors.length === 0, errors, policy };
}

function rootMap(trustRoots) {
  const roots = trustRoots instanceof Map ? [...trustRoots.values()] : trustRoots;
  if (!Array.isArray(roots) || roots.length === 0) return { error: "trust_roots_invalid" };
  const result = new Map();
  for (const root of roots) {
    if (!root || typeof root !== "object" || Array.isArray(root) || typeof root.authorityId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(root.authorityId)) return { error: "trust_roots_invalid" };
    if (result.has(root.authorityId)) return { error: "trust_roots_duplicate" };
    result.set(root.authorityId, root);
  }
  return { roots: result };
}
async function verifierResult(root, request, timeoutMs) {
  let timer;
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), timeoutMs); });
    const response = await Promise.race([Promise.resolve().then(() => root.verifier(request)), timeout]);
    if (response?.timeout) return { ok: false, error: "verifier_timeout" };
    if (!response || typeof response !== "object" || Array.isArray(response) || Object.keys(response).sort().join(",") !== "accepted,bindingDigest" || typeof response.accepted !== "boolean" || typeof response.bindingDigest !== "string") return { ok: false, error: "verifier_malformed_response" };
    if (response.accepted !== true) return { ok: false, error: "verifier_rejected" };
    if (response.bindingDigest !== request.bindingDigest) return { ok: false, error: "verifier_binding_mismatch" };
    return { ok: true };
  } catch { return { ok: false, error: "verifier_exception" }; } finally { clearTimeout(timer); }
}

/**
 * Verifies a receipt against an explicitly configured connected-authority root.
 * The verifier receives only canonical binding data and must echo its digest.
 * No default root, verifier, or permissive fallback exists.
 */
export async function verifyAuthoritativeReceiptV1(receipt, { trustRoots, freshness, now = Date.now(), limits } = {}) {
  const structural = validateAuthoritativeReceiptV1(receipt, { limits });
  if (!structural.ok) return structural;
  const fresh = validateReceiptFreshness(receipt, { freshness, now });
  if (!fresh.ok) return { ok: false, errors: fresh.errors };
  const configuredRoots = rootMap(trustRoots);
  if (configuredRoots.error) return { ok: false, errors: [issue(configuredRoots.error, "configured authority roots are malformed, empty, or duplicate", "/authority")] };
  const root = configuredRoots.roots.get(receipt.authority.id);
  if (!root) return { ok: false, errors: [issue("authority_unconfigured", "authority has no configured connected-authority trust root", "/authority/id")] };
  if (typeof root.verifier !== "function") return { ok: false, errors: [issue("verifier_required", "configured authority requires a verifier function", "/authority/id")] };
  if (!Array.isArray(root.producerIds) || !root.producerIds.includes(receipt.producer.id)) return { ok: false, errors: [issue("producer_authority_mismatch", "producer is not connected to this configured authority", "/producer/id")] };
  const timeoutMs = root.timeoutMs ?? configuredLimits(limits).maxVerifierTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > configuredLimits(limits).maxVerifierTimeoutMs) return { ok: false, errors: [issue("verifier_timeout_invalid", "verifier timeout is outside configured receipt bounds", "/authority/id")] };
  const binding = authoritativeReceiptBinding(receipt), bindingDigest = authoritativeReceiptBindingDigest(receipt);
  const verified = await verifierResult(root, Object.freeze({ authorityId: root.authorityId, receiptId: receipt.receipt.id, producerId: receipt.producer.id, binding: structuredClone(binding), bindingDigest }), timeoutMs);
  if (!verified.ok) return { ok: false, errors: [issue(verified.error, "configured authority verifier did not positively verify this receipt", "/authority/attestation")] };
  return { ok: true, errors: [], canonicalPayload: structural.canonicalPayload, payloadDigest: structural.payloadDigest, binding, bindingDigest, freshness: fresh.policy };
}

export class AuthoritativeReceiptValidationError extends Error {
  constructor(errors) { super(`Authoritative receipt validation failed: ${errors.map((error) => error.code).join(", ")}`); this.name = "AuthoritativeReceiptValidationError"; this.errors = errors; }
}
