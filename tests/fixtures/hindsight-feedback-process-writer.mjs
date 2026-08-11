import { appendHindsightFeedback } from "../../extensions/conversation-catalog/src/hindsight-feedback.mjs";

const [path, targetId, index] = process.argv.slice(2);
await appendHindsightFeedback(path, targetId, {
  classification: Number(index) % 2 ? "helpful" : "incomplete",
  correctedFraming: `Process ${index} supplied local framing.`,
  provenance: { source: "user-feedback", confirmation: "user-confirmed", recordedAt: `2026-08-15T12:00:${String(Number(index) % 60).padStart(2, "0")}.000Z` },
});
