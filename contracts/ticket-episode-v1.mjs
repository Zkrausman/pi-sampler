import { Type } from "typebox";
import { Compile } from "typebox/compile";

export const TICKET_EPISODE_V1_SCHEMA_ID = "https://pi-sampler.dev/contracts/ticket-episode/v1";
export const TICKET_EPISODE_V1_SCHEMA_VERSION = "1.0.0";

const identifier = (title) => Type.String({
  title,
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$",
});
const immutableRevision = Type.String({
  title: "Immutable Git revision",
  pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$",
});
const timestamp = Type.String({ title: "UTC RFC 3339 timestamp", format: "date-time" });
const recordState = Type.Union([
  Type.Literal("complete"),
  Type.Literal("partial"),
  Type.Literal("quarantined"),
  Type.Literal("superseded"),
  Type.Literal("conflicting"),
]);
const evidenceClass = Type.Union([
  Type.Literal("observed_evidence"),
  Type.Literal("human_annotation"),
  Type.Literal("caller_claim"),
  Type.Literal("model_inference"),
]);

/**
 * Canonical Ticket Episode v1 schema. This TypeBox value is the sole schema
 * source: the executable validator compiles it and the JSON Schema artifact is
 * generated from it by scripts/export-ticket-episode-v1-schema.mjs.
 */
export const TicketEpisodeV1Schema = Type.Object({
  schema: Type.Object({
    id: Type.Literal(TICKET_EPISODE_V1_SCHEMA_ID),
    version: Type.Literal(TICKET_EPISODE_V1_SCHEMA_VERSION),
  }, { additionalProperties: false }),
  project: Type.Object({ id: identifier("Project identity") }, { additionalProperties: false }),
  repository: Type.Object({
    id: identifier("Repository identity"),
    revision: immutableRevision,
  }, { additionalProperties: false }),
  ticket: Type.Object({
    system: identifier("Work-item system"),
    id: identifier("Ticket or work-item identity"),
  }, { additionalProperties: false }),
  episode: Type.Object({ id: identifier("Episode identity") }, { additionalProperties: false }),
  attempt: Type.Object({ id: identifier("Attempt identity") }, { additionalProperties: false }),
  session: Type.Object({ id: identifier("Session identity") }, { additionalProperties: false }),
  agentRun: Type.Object({
    agentId: identifier("Agent identity"),
    runId: identifier("Run identity"),
  }, { additionalProperties: false }),
  event: Type.Object({
    id: identifier("Event identity"),
    kind: Type.Union([
      Type.Literal("conversation"),
      Type.Literal("annotation"),
      Type.Literal("usage"),
      Type.Literal("artifact"),
      Type.Literal("outcome"),
      Type.Literal("retrospective"),
      Type.Literal("lesson"),
      Type.Literal("evolution"),
    ]),
  }, { additionalProperties: false }),
  producer: Type.Object({
    id: identifier("Producer identity"),
    kind: Type.Union([
      Type.Literal("human"),
      Type.Literal("pi_extension"),
      Type.Literal("adapter"),
      Type.Literal("model"),
      Type.Literal("connected_authority"),
      Type.Literal("system"),
    ]),
  }, { additionalProperties: false }),
  occurredAt: timestamp,
  sequence: Type.Integer({ minimum: 0, title: "Monotonic sequence within an episode" }),
  evidence: Type.Object({
    class: evidenceClass,
    authority: Type.Object({
      level: Type.Union([Type.Literal("untrusted"), Type.Literal("attested")]),
      authorityId: Type.Optional(identifier("Attesting authority identity")),
      attestationId: Type.Optional(identifier("Attestation identity")),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  state: recordState,
  coverage: Type.Object({
    status: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
    expectedEventCount: Type.Integer({ minimum: 1 }),
    observedEventCount: Type.Integer({ minimum: 0 }),
    missingEventIds: Type.Array(identifier("Explicitly missing event identity"), { uniqueItems: true }),
  }, { additionalProperties: false }),
  supersedesEventId: Type.Optional(identifier("Superseded event identity")),
  conflictsWithEventIds: Type.Optional(Type.Array(identifier("Conflicting event identity"), { minItems: 1, uniqueItems: true })),
}, {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: TICKET_EPISODE_V1_SCHEMA_ID,
  title: "Ticket Episode v1 event",
  additionalProperties: false,
});

const compiledSchema = Compile(TicketEpisodeV1Schema);

function issue(code, message, path = "") {
  return { code, message, path };
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function ticketKey(record) {
  return `${record.project.id}\u0000${record.ticket.system}\u0000${record.ticket.id}`;
}

/**
 * Validates one Ticket Episode v1 event. Attested observed evidence is accepted
 * only when the caller supplies a configured trust root and verifier. This
 * intentionally does not implement signing, persistence, adapters, or authority
 * discovery; those belong to later contracts.
 */
export function validateTicketEpisodeV1(record, options = {}) {
  const errors = [...compiledSchema.Errors(record)].map((error) => issue(
    "schema_invalid",
    error.message,
    error.path,
  ));
  if (errors.length > 0) return { ok: false, errors };

  if (!canonicalTimestamp(record.occurredAt)) {
    errors.push(issue("timestamp_not_canonical", "occurredAt must be a canonical UTC RFC 3339 timestamp with milliseconds", "/occurredAt"));
  }

  const { evidence, producer, coverage, state } = record;
  if (evidence.class === "human_annotation" && producer.kind !== "human") {
    errors.push(issue("annotation_producer_invalid", "human_annotation requires a human producer", "/producer/kind"));
  }
  if (evidence.class === "model_inference" && producer.kind !== "model") {
    errors.push(issue("inference_producer_invalid", "model_inference requires a model producer", "/producer/kind"));
  }
  if (evidence.class === "caller_claim" && !["pi_extension", "adapter", "system"].includes(producer.kind)) {
    errors.push(issue("claim_producer_invalid", "caller_claim requires a Pi extension, adapter, or system producer", "/producer/kind"));
  }
  if (evidence.class === "observed_evidence" && producer.kind !== "connected_authority") {
    errors.push(issue("observation_producer_invalid", "observed_evidence requires a connected-authority producer", "/producer/kind"));
  }
  if (evidence.class === "observed_evidence" && evidence.authority.level !== "attested") {
    errors.push(issue("observation_attestation_required", "observed_evidence requires a verified attestation", "/evidence/authority/level"));
  }

  if (evidence.authority.level === "attested") {
    const trusted = new Set(options.trustedAuthorityIds ?? []);
    if (evidence.class !== "observed_evidence") {
      errors.push(issue("attestation_class_invalid", "only observed_evidence may carry an attested authority", "/evidence/class"));
    }
    if (producer.kind !== "connected_authority") {
      errors.push(issue("attestation_producer_invalid", "attested evidence must be produced by a connected authority", "/producer/kind"));
    }
    if (!evidence.authority.authorityId || !evidence.authority.attestationId) {
      errors.push(issue("attestation_identity_missing", "attested evidence requires authorityId and attestationId", "/evidence/authority"));
    }
    if (evidence.authority.authorityId !== producer.id) {
      errors.push(issue("attestation_producer_mismatch", "authorityId must equal the connected-authority producer id", "/evidence/authority/authorityId"));
    }
    if (!trusted.has(producer.id)) {
      errors.push(issue("authority_untrusted", "the connected authority is not configured as trusted", "/producer/id"));
    }
    if (typeof options.verifyAttestation !== "function") {
      errors.push(issue("attestation_verifier_required", "attested evidence requires an authority verifier", "/evidence/authority"));
    } else if (errors.length === 0 && options.verifyAttestation(record) !== true) {
      errors.push(issue("attestation_invalid", "the authority verifier rejected the attestation", "/evidence/authority"));
    }
  } else if (evidence.authority.authorityId || evidence.authority.attestationId) {
    errors.push(issue("untrusted_attestation_fields", "untrusted evidence must not carry authority or attestation identities", "/evidence/authority"));
  }

  if (coverage.status === "complete") {
    if (coverage.expectedEventCount !== coverage.observedEventCount || coverage.missingEventIds.length !== 0) {
      errors.push(issue("coverage_complete_inconsistent", "complete coverage must observe every expected event and declare no missing IDs", "/coverage"));
    }
  } else if (coverage.observedEventCount >= coverage.expectedEventCount || coverage.missingEventIds.length === 0) {
    errors.push(issue("coverage_partial_undeclared", "partial coverage must declare fewer observed events and at least one missing event ID", "/coverage"));
  }
  if (state === "complete" && coverage.status !== "complete") {
    errors.push(issue("complete_state_partial_coverage", "a complete record cannot silently carry partial coverage", "/state"));
  }
  if ((state === "complete" || coverage.status === "complete") && (evidence.class !== "observed_evidence" || evidence.authority.level !== "attested")) {
    errors.push(issue("completion_authority_required", "complete state or coverage requires attested observed evidence", "/state"));
  }
  if (state === "partial" && coverage.status !== "partial") {
    errors.push(issue("partial_state_coverage_missing", "a partial record must declare partial coverage", "/state"));
  }
  if (state === "superseded" && !record.supersedesEventId) {
    errors.push(issue("supersession_target_missing", "a superseded record must name the event that supersedes it", "/supersedesEventId"));
  }
  if (state === "conflicting" && !record.conflictsWithEventIds?.length) {
    errors.push(issue("conflict_target_missing", "a conflicting record must name at least one conflicting event", "/conflictsWithEventIds"));
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validates a supplied ordering of records. Identity reuse is permitted only
 * inside one ticket; event IDs themselves are one-use. Sequences and timestamps
 * must move forward within each episode in the supplied order.
 */
export function validateTicketEpisodeTimelineV1(records, options = {}) {
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, errors: [issue("timeline_empty", "timeline must contain at least one record", "/")] };
  }

  const errors = [];
  const ownership = new Map();
  const eventIds = new Set();
  const chronology = new Map();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const result = validateTicketEpisodeV1(record, options);
    for (const error of result.errors) errors.push({ ...error, path: `/records/${index}${error.path}` });
    if (!result.ok) continue;

    const owner = ticketKey(record);
    for (const [name, id] of [
      ["episode", record.episode.id],
      ["attempt", record.attempt.id],
      ["session", record.session.id],
      ["agentRun", record.agentRun.runId],
    ]) {
      const key = `${name}\u0000${id}`;
      const previousOwner = ownership.get(key);
      if (previousOwner && previousOwner !== owner) {
        errors.push(issue("cross_ticket_duplicate_id", `${name} id ${id} is already bound to another ticket`, `/records/${index}/${name}`));
      } else {
        ownership.set(key, owner);
      }
    }
    if (eventIds.has(record.event.id)) {
      errors.push(issue("duplicate_event_id", `event id ${record.event.id} is already present in this timeline`, `/records/${index}/event/id`));
    } else {
      eventIds.add(record.event.id);
    }

    const prior = chronology.get(record.episode.id);
    if (prior && record.sequence <= prior.sequence) {
      errors.push(issue("sequence_reversed", "sequence must strictly increase within an episode", `/records/${index}/sequence`));
    }
    if (prior && Date.parse(record.occurredAt) < Date.parse(prior.occurredAt)) {
      errors.push(issue("chronology_reversed", "occurredAt must not move backwards within an episode", `/records/${index}/occurredAt`));
    }
    chronology.set(record.episode.id, record);
  }
  return { ok: errors.length === 0, errors };
}

export function assertTicketEpisodeTimelineV1(records, options = {}) {
  const result = validateTicketEpisodeTimelineV1(records, options);
  if (!result.ok) throw new TicketEpisodeValidationError(result.errors);
  return records;
}

export class TicketEpisodeValidationError extends Error {
  constructor(errors) {
    super(`Ticket Episode v1 validation failed: ${errors.map((error) => error.code).join(", ")}`);
    this.name = "TicketEpisodeValidationError";
    this.errors = errors;
  }
}
