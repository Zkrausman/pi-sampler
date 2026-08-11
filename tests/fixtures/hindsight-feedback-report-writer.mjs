import { recordHindsightFeedback } from "../../extensions/conversation-catalog/src/hindsight-feedback.mjs";

const [feedbackPath, targetId, dispositionPath, outcomePath, reportPath, feedbackReportPath] = process.argv.slice(2);
await recordHindsightFeedback(feedbackPath, targetId, {
  classification: "helpful",
  correctedFraming: "Local feedback process framing.",
  provenance: { source: "user-feedback", confirmation: "user-confirmed", recordedAt: "2026-08-20T12:00:00.000Z" },
}, { dispositionPath, outcomePath, reportPath, feedbackReportPath });
