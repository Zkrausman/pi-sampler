import { recordHindsightOutcomeUpdate, createHindsightOutcomeOrigin } from "../../extensions/conversation-catalog/src/hindsight-outcomes.mjs";

const [outcomesPath, reportPath, outcomeReportPath, index] = process.argv.slice(2);
const recommendation = {
  recommendationNumber: 1,
  recommendation: "Process-safe retry policy",
  priority: "high",
  expectedImpact: "Avoid lost updates",
  suggestedOwner: "Platform",
  dependencies: [],
  acceptanceCriteria: ["Every concurrent update is retained"],
  evidenceReferences: ["session-proc:event-0001"],
  userDisposition: { status: "accepted", source: "user-confirmed" },
};
const origin = createHindsightOutcomeOrigin("hindsight-1234abcd", recommendation);
await recordHindsightOutcomeUpdate(outcomesPath, origin, {
  status: "completed",
  observedResult: `Process ${index} observed the local update.`,
  measurementEvidence: `Process ${index} confirmed its update persisted.`,
  unexpectedEffects: "None observed.",
  followUpDecision: "monitor",
  provenance: { source: "user-observed", confirmation: "user-confirmed", confirmedAt: `2026-08-12T12:00:${String(Number(index) % 60).padStart(2, "0")}.000Z` },
}, { reportPath, outcomeReportPath });
