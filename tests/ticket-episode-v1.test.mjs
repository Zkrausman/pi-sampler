import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  TICKET_EPISODE_V1_SCHEMA_ID,
  TICKET_EPISODE_V1_SCHEMA_VERSION,
  validateTicketEpisodeTimelineV1,
  validateTicketEpisodeV1,
} from "../contracts/ticket-episode-v1.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function record(overrides = {}) {
  const base = {
    schema: { id: TICKET_EPISODE_V1_SCHEMA_ID, version: TICKET_EPISODE_V1_SCHEMA_VERSION },
    project: { id: "pi-sampler" },
    repository: { id: "github.com/Zkrausman/pi-sampler", revision: "a".repeat(40) },
    ticket: { system: "linear", id: "AIDEV-123" },
    episode: { id: "episode-1" },
    attempt: { id: "attempt-1" },
    session: { id: "session-1" },
    agentRun: { agentId: "agent-1", runId: "run-1" },
    event: { id: "event-1", kind: "conversation" },
    producer: { id: "pi-extension-1", kind: "pi_extension" },
    occurredAt: "2026-08-17T00:00:00.000Z",
    sequence: 0,
    evidence: { class: "caller_claim", authority: { level: "untrusted" } },
    state: "quarantined",
    coverage: { status: "partial", expectedEventCount: 2, observedEventCount: 1, missingEventIds: ["event-unavailable"] },
  };
  return {
    ...base,
    ...overrides,
    schema: { ...base.schema, ...overrides.schema },
    project: { ...base.project, ...overrides.project },
    repository: { ...base.repository, ...overrides.repository },
    ticket: { ...base.ticket, ...overrides.ticket },
    episode: { ...base.episode, ...overrides.episode },
    attempt: { ...base.attempt, ...overrides.attempt },
    session: { ...base.session, ...overrides.session },
    agentRun: { ...base.agentRun, ...overrides.agentRun },
    event: { ...base.event, ...overrides.event },
    producer: { ...base.producer, ...overrides.producer },
    evidence: { ...base.evidence, ...overrides.evidence, authority: { ...base.evidence.authority, ...overrides.evidence?.authority } },
    coverage: { ...base.coverage, ...overrides.coverage },
  };
}

function codes(result) {
  return result.errors.map(({ code }) => code);
}

test("Ticket Episode v1 accepts all four evidence classes only with their allowed producers", () => {
  assert.equal(validateTicketEpisodeV1(record()).ok, true);
  assert.equal(validateTicketEpisodeV1(record({
    event: { id: "event-human", kind: "annotation" },
    producer: { id: "human-1", kind: "human" },
    evidence: { class: "human_annotation", authority: { level: "untrusted" } },
  })).ok, true);
  assert.equal(validateTicketEpisodeV1(record({
    event: { id: "event-model", kind: "retrospective" },
    producer: { id: "model-1", kind: "model" },
    evidence: { class: "model_inference", authority: { level: "untrusted" } },
  })).ok, true);
  assert.equal(validateTicketEpisodeV1(record({
    event: { id: "event-observed", kind: "artifact" },
    producer: { id: "authority-1", kind: "connected_authority" },
    evidence: { class: "observed_evidence", authority: { level: "attested", authorityId: "authority-1", attestationId: "receipt-1" } },
    state: "complete",
    coverage: { status: "complete", expectedEventCount: 1, observedEventCount: 1, missingEventIds: [] },
  }), { trustedAuthorityIds: ["authority-1"], verifyAttestation: () => true }).ok, true);
});

test("Ticket Episode v1 rejects forged authority and incompatible schema drift", () => {
  const forged = validateTicketEpisodeV1(record({
    producer: { id: "model-1", kind: "model" },
    evidence: { class: "model_inference", authority: { level: "attested", authorityId: "model-1", attestationId: "forged-1" } },
  }), { trustedAuthorityIds: ["model-1"], verifyAttestation: () => true });
  assert.equal(forged.ok, false);
  assert.ok(codes(forged).includes("attestation_class_invalid"));
  assert.ok(codes(forged).includes("attestation_producer_invalid"));

  for (const producer of [
    { id: "model-2", kind: "model" },
    { id: "adapter-1", kind: "adapter" },
  ]) {
    const relabeledObservation = validateTicketEpisodeV1(record({
      producer,
      evidence: { class: "observed_evidence", authority: { level: "untrusted" } },
    }));
    assert.equal(relabeledObservation.ok, false);
    assert.ok(codes(relabeledObservation).includes("observation_producer_invalid"));
    assert.ok(codes(relabeledObservation).includes("observation_attestation_required"));
  }

  const forgedCompletion = validateTicketEpisodeV1(record({
    state: "complete",
    coverage: { status: "complete", expectedEventCount: 1, observedEventCount: 1, missingEventIds: [] },
  }));
  assert.equal(forgedCompletion.ok, false);
  assert.ok(codes(forgedCompletion).includes("completion_authority_required"));

  const drift = validateTicketEpisodeV1(record({ schema: { version: "1.0.1" } }));
  assert.equal(drift.ok, false);
  assert.ok(codes(drift).includes("schema_invalid"));
});

test("Ticket Episode v1 rejects reversed chronology and cross-ticket identity reuse", () => {
  const first = record();
  const reversed = record({
    event: { id: "event-2", kind: "usage" },
    occurredAt: "2026-08-16T23:59:59.000Z",
    sequence: 0,
  });
  const chronology = validateTicketEpisodeTimelineV1([first, reversed]);
  assert.equal(chronology.ok, false);
  assert.ok(codes(chronology).includes("sequence_reversed"));
  assert.ok(codes(chronology).includes("chronology_reversed"));

  const otherTicket = record({
    ticket: { id: "AIDEV-124" },
    event: { id: "event-3", kind: "outcome" },
    sequence: 1,
    occurredAt: "2026-08-17T00:00:01.000Z",
  });
  const ownership = validateTicketEpisodeTimelineV1([first, otherTicket]);
  assert.equal(ownership.ok, false);
  assert.ok(codes(ownership).includes("cross_ticket_duplicate_id"));
});

test("Ticket Episode v1 rejects silent partial coverage", () => {
  const partial = validateTicketEpisodeV1(record({
    state: "complete",
    coverage: { status: "partial", expectedEventCount: 2, observedEventCount: 1, missingEventIds: ["event-unavailable"] },
  }));
  assert.equal(partial.ok, false);
  assert.ok(codes(partial).includes("complete_state_partial_coverage"));

  const undeclared = validateTicketEpisodeV1(record({
    state: "partial",
    coverage: { status: "partial", expectedEventCount: 2, observedEventCount: 2, missingEventIds: [] },
  }));
  assert.equal(undeclared.ok, false);
  assert.ok(codes(undeclared).includes("coverage_partial_undeclared"));
});

test("Ticket Episode v1 enforces directed supersession links without requiring a complete timeline", () => {
  const superseded = record({
    state: "superseded",
    supersededByEventId: "event-replacement-not-in-timeline",
  });
  assert.equal(validateTicketEpisodeV1(superseded).ok, true);
  assert.equal(validateTicketEpisodeTimelineV1([superseded]).ok, true);

  const missing = validateTicketEpisodeV1(record({ state: "superseded" }));
  assert.ok(codes(missing).includes("superseded_by_target_missing"));
  for (const state of ["complete", "partial", "quarantined", "conflicting"]) {
    const unrelated = validateTicketEpisodeV1(record({ state, supersededByEventId: "event-replacement" }));
    assert.ok(codes(unrelated).includes("superseded_by_state_invalid"), `${state} must reject supersededByEventId`);
  }
  const self = validateTicketEpisodeV1(record({ state: "superseded", supersededByEventId: "event-1" }));
  assert.ok(codes(self).includes("superseded_by_self"));
});

test("Ticket Episode v1 enforces conflict links without requiring a complete timeline", () => {
  const conflicting = record({
    state: "conflicting",
    conflictsWithEventIds: ["event-conflict-not-in-timeline"],
  });
  assert.equal(validateTicketEpisodeV1(conflicting).ok, true);
  assert.equal(validateTicketEpisodeTimelineV1([conflicting]).ok, true);

  const missing = validateTicketEpisodeV1(record({ state: "conflicting" }));
  assert.ok(codes(missing).includes("conflict_target_missing"));
  for (const state of ["complete", "partial", "quarantined", "superseded"]) {
    const unrelated = validateTicketEpisodeV1(record({ state, conflictsWithEventIds: ["event-conflict"] }));
    assert.ok(codes(unrelated).includes("conflict_targets_state_invalid"), `${state} must reject conflictsWithEventIds`);
  }
  const self = validateTicketEpisodeV1(record({ state: "conflicting", conflictsWithEventIds: ["event-1"] }));
  assert.ok(codes(self).includes("conflict_self_reference"));
  const duplicate = validateTicketEpisodeV1(record({ state: "conflicting", conflictsWithEventIds: ["event-conflict", "event-conflict"] }));
  assert.ok(codes(duplicate).includes("schema_invalid"));
});

test("the generated JSON Schema is exactly derived from the canonical executable schema", async () => {
  const command = spawnSync(process.execPath, ["scripts/export-ticket-episode-v1-schema.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(command.status, 0, command.stderr);

  const [schema, specification] = await Promise.all([
    readFile(join(root, "contracts", "ticket-episode-v1.schema.json"), "utf8").then(JSON.parse),
    readFile(join(root, "docs", "specs", "TICKET-EPISODE-V1.md"), "utf8"),
  ]);
  assert.equal(schema.$id, TICKET_EPISODE_V1_SCHEMA_ID);
  assert.match(specification, /## Evidence classes/);
  assert.match(specification, /## Threat model/);
  assert.match(specification, /AIDEV-130/);
});
