import { LESSON_V1_SCHEMA_ID, LESSON_V1_SCHEMA_VERSION } from "../../contracts/lesson-v1.mjs";
import { lessonDigestV1 } from "../../ledgers/lesson-registry.mjs";
import { TICKET_EPISODE_V1_SCHEMA_ID, TICKET_EPISODE_V1_SCHEMA_VERSION } from "../../contracts/ticket-episode-v1.mjs";

export function lesson(overrides = {}) {
  const base = {
    schema: { id: LESSON_V1_SCHEMA_ID, version: LESSON_V1_SCHEMA_VERSION }, id: "lesson-safe-release", version: 1, state: "proposed",
    applicability: { scope: "delivery", conditions: ["protected branch release"] },
    behavior: { kind: "test", instruction: "Run the protected release gate before publication." },
    evidence: [
      { episodeId: "episode-a", eventId: "event-a", ticket: { system: "linear", id: "AIDEV-101" }, citation: "Release gate prevented publication.", observedAt: "2026-08-19T00:00:00.000Z" },
      { episodeId: "episode-b", eventId: "event-b", ticket: { system: "linear", id: "AIDEV-102" }, citation: "Release gate caught a stale artifact.", observedAt: "2026-08-19T00:01:00.000Z" },
    ], annotations: [], counterevidence: [], confidence: 0.8, risk: "medium",
    decisions: [{ id: "decision-1", decidedBy: "maintainer-1", decidedAt: "2026-08-19T00:02:00.000Z", rationale: "Retain as an inspectable candidate." }],
    provenance: { createdAt: "2026-08-19T00:03:00.000Z", createdBy: "retrospective-1" },
  };
  return { ...base, ...overrides, schema: { ...base.schema, ...overrides.schema }, applicability: { ...base.applicability, ...overrides.applicability }, behavior: { ...base.behavior, ...overrides.behavior }, provenance: { ...base.provenance, ...overrides.provenance } };
}

export function nextLesson(previous, state, overrides = {}) {
  const next = lesson({ ...previous, ...overrides, version: previous.version + 1, state, provenance: { ...previous.provenance, ...overrides.provenance, createdAt: `2026-08-19T00:${String(previous.version + 3).padStart(2, "0")}:00.000Z`, parent: { lessonId: previous.id, version: previous.version, digest: lessonDigestV1(previous) } }, evaluator: overrides.evaluator ?? previous.evaluator ?? { id: "evaluator-1", kind: "human", evaluatedAt: "2026-08-19T00:04:00.000Z" } });
  return next;
}

export function emergencyLesson(overrides = {}) {
  return lesson({ id: "lesson-catastrophic-delete", behavior: { kind: "avoid", instruction: "Never recursively delete an unverified workspace root." }, evidence: [{ episodeId: "episode-catastrophe", eventId: "event-catastrophe", ticket: { system: "linear", id: "AIDEV-199" }, citation: "An unsafe root would destroy unrelated workspaces.", observedAt: "2026-08-19T00:00:00.000Z" }], risk: "catastrophic", catastrophicSafety: { policyId: "emergency-prohibition-v1", authorizedBy: "maintainer-1", authorizedAt: "2026-08-19T00:02:00.000Z", rationale: "Immediate narrow prohibition is necessary.", narrowProhibition: true }, ...overrides });
}

export function episodeRecord(value) {
  const sequence = value.version - 1;
  return { schema: { id: TICKET_EPISODE_V1_SCHEMA_ID, version: TICKET_EPISODE_V1_SCHEMA_VERSION }, project: { id: "pi-sampler" }, repository: { id: "github.com/Zkrausman/pi-sampler", revision: "a".repeat(40) }, ticket: { system: "linear", id: "AIDEV-133" }, episode: { id: `lesson:${value.id}` }, attempt: { id: `lesson-attempt:${value.id}` }, session: { id: `lesson-session:${value.id}` }, agentRun: { agentId: "lesson-registry", runId: `lesson-run:${value.id}` }, event: { id: `lesson-event:${value.id}:${value.version}`, kind: "lesson" }, producer: { id: "lesson-registry", kind: "system" }, occurredAt: `2026-08-19T01:${String(sequence).padStart(2, "0")}:00.000Z`, sequence, evidence: { class: "caller_claim", authority: { level: "untrusted" } }, state: "partial", coverage: { status: "partial", expectedEventCount: value.version + 1, observedEventCount: value.version, missingEventIds: [`lesson-next:${value.id}:${value.version + 1}`] } };
}
