import {
  LESSON_V1_SCHEMA_ID,
  LESSON_V1_SCHEMA_VERSION,
  canonicalJson,
  lessonContentDigest,
  sha256Hex,
} from "../../contracts/lesson-v1.mjs";

const clone = (value) => structuredClone(value);
const merge = (base, overrides = {}) => ({
  ...base,
  ...overrides,
  schema: { ...base.schema, ...overrides.schema },
  applicability: { ...base.applicability, ...overrides.applicability, conditions: overrides.applicability?.conditions ?? base.applicability.conditions },
  behavior: { ...base.behavior, ...overrides.behavior },
  provenance: { ...base.provenance, ...overrides.provenance, sourceEpisodes: overrides.provenance?.sourceEpisodes ?? base.provenance.sourceEpisodes, sourceTickets: overrides.provenance?.sourceTickets ?? base.provenance.sourceTickets, humanDecisions: overrides.provenance?.humanDecisions ?? base.provenance.humanDecisions },
  evaluator: { ...base.evaluator, ...overrides.evaluator },
  risk: { ...base.risk, ...overrides.risk },
  evidence: overrides.evidence ?? base.evidence,
  annotations: overrides.annotations ?? base.annotations,
  counterevidence: overrides.counterevidence ?? base.counterevidence,
  stateHistory: overrides.stateHistory ?? base.stateHistory,
});

export function lesson(overrides = {}) {
  const base = {
    schema: { id: LESSON_V1_SCHEMA_ID, version: LESSON_V1_SCHEMA_VERSION },
    id: "lesson-avoid-retry",
    version: 1,
    state: "proposed",
    applicability: { conditions: [{ field: "task.kind", operator: "equals", value: "retry" }] },
    behavior: { kind: "avoid", description: "Do not retry after an idempotency conflict", action: "stop-and-request-review", target: "idempotency-conflict" },
    evidence: [
      { id: "evidence-a", kind: "supporting", episodeId: "episode-a", eventId: "event-a", ticketId: "AIDEV-101", citation: "observed conflict" },
      { id: "evidence-b", kind: "supporting", episodeId: "episode-b", eventId: "event-b", ticketId: "AIDEV-102", citation: "repeat conflict" },
    ],
    annotations: [{ id: "annotation-1", authorId: "human-reviewer", body: "Human reviewed the repeated behavior", createdAt: "2026-08-17T00:00:00.000Z", decision: "support" }],
    counterevidence: [],
    confidence: 0.9,
    risk: { level: "high", rationale: "Retrying can duplicate a durable operation" },
    provenance: {
      sourceEpisodes: ["episode-a", "episode-b"],
      sourceTickets: ["AIDEV-101", "AIDEV-102"],
      humanDecisions: [{ id: "decision-1", authorId: "human-reviewer", decision: "approve", decidedAt: "2026-08-17T00:00:00.000Z", rationale: "The evidence is independently repeated" }],
      createdBy: "human-reviewer",
      createdAt: "2026-08-17T00:00:00.000Z",
      repositoryRevision: "a".repeat(40),
    },
    evaluator: { id: "evaluator-1", version: "v1", identityDigest: sha256Hex(canonicalJson({ id: "evaluator-1", version: "v1" })) },
    contentDigest: "0".repeat(64),
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    stateHistory: [],
  };
  const result = merge(base, overrides);
  result.contentDigest = lessonContentDigest(result);
  return result;
}

export const validLesson = lesson;

export function catastrophicLesson(overrides = {}) {
  const result = lesson({
    id: "lesson-catastrophic-stop",
    behavior: { kind: "avoid", description: "Immediately prohibit the unsafe operation", action: "halt", target: "unsafe-operation" },
    evidence: [{ id: "catastrophic-evidence", kind: "supporting", episodeId: "catastrophic-episode", eventId: "catastrophic-event", ticketId: "AIDEV-999", citation: "catastrophic safety event" }],
    provenance: {
      sourceEpisodes: ["catastrophic-episode"],
      sourceTickets: ["AIDEV-999"],
      humanDecisions: [{ id: "catastrophic-decision", authorId: "safety-owner", decision: "approve", decidedAt: "2026-08-17T00:00:00.000Z", episodeId: "catastrophic-episode", eventId: "catastrophic-event", ticketId: "AIDEV-999", rationale: "Immediate narrow prohibition" }],
    },
    risk: { level: "critical", rationale: "The operation caused catastrophic safety harm" },
    catastrophicSafetyException: {
      kind: "catastrophic_safety",
      policyVersion: LESSON_V1_SCHEMA_VERSION,
      episodeId: "catastrophic-episode",
      eventId: "catastrophic-event",
      ticketId: "AIDEV-999",
      reason: "A single catastrophic safety episode requires an immediate prohibition",
      approvedBy: "safety-owner",
      humanDecisionId: "catastrophic-decision",
      scope: { kind: "avoid", target: "unsafe-operation" },
      immediate: true,
      approvedAt: "2026-08-17T00:00:00.000Z",
    },
  });
  const merged = merge(result, overrides);
  merged.contentDigest = lessonContentDigest(merged);
  return merged;
}

export function zeroEvidenceLesson() { return lesson({ evidence: [], provenance: { sourceEpisodes: [], sourceTickets: [] } }); }
export function malformedCatastrophicLesson() { return lesson({ evidence: [{ id: "cat-evidence", kind: "supporting", episodeId: "episode-a", eventId: "event-a", ticketId: "AIDEV-101" }], provenance: { sourceEpisodes: ["episode-a"], sourceTickets: ["AIDEV-101"] }, catastrophicSafetyException: {} }); }
export function singleTicketLesson(overrides = {}) { return lesson({ evidence: [{ id: "single-evidence", kind: "supporting", episodeId: "episode-a", eventId: "event-a", ticketId: "AIDEV-101" }], provenance: { sourceEpisodes: ["episode-a"], sourceTickets: ["AIDEV-101"] }, ...overrides }); }

export function cloneLesson(value) { return clone(value); }
