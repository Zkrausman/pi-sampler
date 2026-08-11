import assert from "node:assert/strict";
import test from "node:test";
import { attachEvidenceReferences, createEvidenceManifest, generateCitedHindsightDocumentHtml } from "../extensions/conversation-catalog/src/evidence.mjs";
import { generateConversationFlowHtml } from "../extensions/conversation-catalog/src/flow.mjs";

const projection = {
  events: [
    { id: "event-1", category: "user", title: "User", timestamp: "2025-01-01 UTC", summary: "Customer asked for <b>help</b>", metadata: [] },
    { id: "event-2", category: "assistant", title: "Assistant", timestamp: "2025-01-02 UTC", summary: "Provided a response", metadata: [] },
  ],
  edges: [{ from: "event-1", to: "event-2", label: "parent entry" }],
};

test("evidence references are stable, direct, and persistence-safe", () => {
  const cited = attachEvidenceReferences('session"><secret>', projection);
  assert.deepEqual(cited.events.map((event) => event.evidence.reference), ["session---secret-:event-0001", "session---secret-:event-0002"]);
  assert.ok(cited.events.every((event) => event.evidence.classification === "direct evidence"));
  const manifest = createEvidenceManifest(cited);
  assert.deepEqual(manifest.citations.map((citation) => citation.eventAnchor), ["#event-1", "#event-2"]);
  assert.doesNotMatch(JSON.stringify(manifest), /Customer asked|Provided a response/);
});

test("flow exposes direct citations that point to inspectable event context", () => {
  const cited = attachEvidenceReferences("session-abc", projection);
  const html = generateConversationFlowHtml({ id: "session-abc", name: "Selected conversation" }, cited);
  assert.match(html, /direct evidence/);
  assert.match(html, /session-abc:event-0001/);
  assert.match(html, /this card is the inspectable source context/);
  assert.doesNotMatch(html, /<b>help<\/b>/);
});

test("cited hindsight documents require evidence and label inference", () => {
  const html = generateCitedHindsightDocumentHtml({
    title: "Review",
    claims: [
      { statement: "The user asked for help.", classification: "direct evidence", evidenceReferences: ["session-abc:event-0001"] },
      { statement: "Support may need follow-up.", classification: "inference", evidenceReferences: ["session-abc:event-0002"] },
    ],
    evidence: [
      { reference: "session-abc:event-0001", context: "Customer asked for help" },
      { reference: "session-abc:event-0002", context: "Provided a response" },
    ],
  });
  assert.match(html, /claim-direct-evidence/);
  assert.match(html, /claim-inference/);
  assert.match(html, /href="#citation-1"/);
  assert.match(html, /Customer asked for help/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ claims: [{ statement: "Unsupported", classification: "direct evidence" }], evidence: [] }), /no inspectable source evidence/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ claims: [{ statement: "Missing source", classification: "direct evidence", evidenceReferences: ["not-present"] }], evidence: [] }), /unavailable source evidence/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ claims: [{ statement: "Model statement", classification: "model inference", evidenceReferences: ["event-1"] }], evidence: [{ reference: "event-1", context: "Context" }] }), /explicitly classified/);
});

test("citation anchors do not collide for distinct punctuation and duplicate evidence is rejected", () => {
  const html = generateCitedHindsightDocumentHtml({
    claims: [{ statement: "Two sources", classification: "direct evidence", evidenceReferences: ["a/b", "a?b"] }],
    evidence: [{ reference: "a/b", context: "First" }, { reference: "a?b", context: "Second" }],
  });
  assert.match(html, /id="citation-1"/);
  assert.match(html, /id="citation-2"/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ evidence: [{ reference: "same", context: "A" }, { reference: "same", context: "B" }] }), /unique and non-empty/);
});
