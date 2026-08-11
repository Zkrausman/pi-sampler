import assert from "node:assert/strict";
import test from "node:test";
import { buildHindsightDocument, buildSynthesisPrompt } from "../extensions/conversation-catalog/src/synthesis.mjs";
import { restrictToolsForHindsightSynthesis } from "../extensions/conversation-catalog/src/hindsight-tools.mjs";

const source = (id, summary) => ({
  events: [{ id: `${id}-event-1`, category: "user", timestamp: "2025-01-01", summary, evidence: { reference: `${id}:event-0001` } }],
});

test("excluded selected conversations retain a pseudonymous navigable fallback without blocking two-selection generation", () => {
  const one = source("one", "First");
  const html = buildHindsightDocument([one, { reference: "session-excluded", excluded: true, events: [{ summary: "Hidden", evidence: { reference: "hidden:event-1" } }] }]);
  assert.match(html, /one:event-0001/);
  assert.match(html, /href="#citation-1-flow">flow<\/a>/);
  assert.match(html, /href="#citation-2">session-excluded:excluded<\/a>/);
  assert.match(html, /id="citation-2"/);
  assert.match(html, /Source context was excluded during redaction review/);
  assert.doesNotMatch(html, /Hidden|hidden:event-1/);
});

test("model claims are rendered by the safe HTML contract instead of trusted as markup", () => {
  const html = buildHindsightDocument([source("one", "First"), source("two", "Second")], {
    title: "<unsafe title>",
    claims: [{ statement: "<img src=x onerror=alert(1)>", classification: "inference", evidenceReferences: ["one:event-0001"] }],
  });
  assert.match(html, /&lt;unsafe title&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /href="#citation-1"/);
  assert.throws(() => buildHindsightDocument([source("one", "First"), source("two", "Second")], {
    claims: [{ statement: "Unsupported", classification: "inference", evidenceReferences: ["not-selected"] }],
  }), /outside the selected redacted source bundle/);
});

test("synthesis prompt includes redacted flow and relationship-map context", () => {
  const linked = {
    events: [
      { id: "one-event-1", category: "user", timestamp: "2025-01-01", summary: "First", evidence: { reference: "one:event-0001" } },
      { id: "one-event-2", category: "assistant", timestamp: "2025-01-02", summary: "Second", evidence: { reference: "one:event-0002" } },
    ],
    edges: [{ from: "one-event-1", to: "one-event-2", label: "parent entry" }],
  };
  const prompt = buildSynthesisPrompt([linked, source("two", "Third")]);
  assert.match(prompt, /Do NOT write HTML/);
  assert.match(prompt, /hindsight_document_write/);
  assert.match(prompt, /one:event-0001/);
  assert.match(prompt, /"flowContext":"user · 2025-01-01 · First"/);
  assert.match(prompt, /"mapContext":"parent entry → one:event-0002"/);
});

test("hindsight document rejects fewer than two included conversations", () => assert.throws(() => buildHindsightDocument([source("one", "First")]), /at least two/));

test("hindsight synthesis disables direct file-write tools and restores the session tool set", () => {
  const normalTools = ["read", "write", "edit", "bash", "hindsight_document_write"];
  const setActiveToolsCalls = [];
  const pi = {
    getActiveTools: () => normalTools,
    setActiveTools: (tools) => setActiveToolsCalls.push(tools),
  };

  const restoreTools = restrictToolsForHindsightSynthesis(pi);
  assert.deepEqual(setActiveToolsCalls, [["hindsight_document_write"]]);

  restoreTools();
  restoreTools();
  assert.deepEqual(setActiveToolsCalls, [["hindsight_document_write"], normalTools]);
});
