import { LESSON_V1_SCHEMA_ID, LESSON_V1_SCHEMA_VERSION, lessonDigest } from "../../contracts/lesson-v1.mjs";

export function lessonFixture(overrides = {}) {
  const base = {
    schema: { id: LESSON_V1_SCHEMA_ID, version: LESSON_V1_SCHEMA_VERSION },
    lesson: { id: "lesson-safe-shell", revision: 1 }, state: "proposed",
    applicability: { repositories: ["github.com/Zkrausman/pi-sampler"], taskKinds: ["implementation"] },
    behavior: { action: "avoid", subject: "unsafe-shell-interpolation", guidance: "Use structured process arguments rather than shell interpolation." },
    evidence: [
      { ticket: { system: "linear", id: "AIDEV-101" }, eventId: "event-101", digest: "a".repeat(64) },
      { ticket: { system: "linear", id: "AIDEV-102" }, eventId: "event-102", digest: "b".repeat(64) },
    ],
    provenance: { createdAt: "2026-08-20T00:00:00.000Z", immutableRevision: "c".repeat(64), sourceLessonIds: [] },
  };
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) result[key] = value;
  return result;
}
export const zeroEvidenceLesson = () => lessonFixture({ evidence: [] });
export const singleTicketLesson = () => lessonFixture({ evidence: [lessonFixture().evidence[0]] });
export const malformedBypassLesson = () => ({ ...singleTicketLesson(), catastrophicSafetyException: { category: "catastrophic-safety", severity: "ordinary", rationale: "not a valid exception" } });
export const catastrophicAvoidLesson = () => ({ ...singleTicketLesson(), catastrophicSafetyException: { category: "catastrophic-safety", severity: "catastrophic", rationale: "Prevents destructive irreversible production data loss." } });
export const lessonArtifactDigest = (lesson) => lessonDigest(lesson);
